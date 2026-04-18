const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const https      = require('https');
const fs         = require('fs');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://localhost:27017/abcxyzchat';
const JWT_SECRET = process.env.JWT_SECRET || 'abcxyz_secret_2024';
const PORT       = process.env.PORT       || 3000;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => console.error('MongoDB error:', e));

// =========================================================================
//  MUSIC ASSETS — serve từ assets/music/
// =========================================================================
const MUSIC_DIR   = path.join(__dirname, 'assets', 'music');
const MUSIC_EXTS  = ['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus'];
const MUSIC_MIME  = {
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg; codecs=opus'
};

if (!fs.existsSync(MUSIC_DIR)) {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  console.log('📁 Created assets/music/ — bỏ file nhạc vào đây');
}

function getMusicList() {
  try {
    return fs.readdirSync(MUSIC_DIR)
      .filter(f => MUSIC_EXTS.includes(path.extname(f).toLowerCase()))
      .map((f, i) => {
        const ext  = path.extname(f).toLowerCase();
        const stat = fs.statSync(path.join(MUSIC_DIR, f));
        return {
          id:       i,
          filename: f,
          name:     path.basename(f, ext),
          ext,
          size:     stat.size,
          mime:     MUSIC_MIME[ext] || 'audio/mpeg',
          url:      `/api/music/stream/${encodeURIComponent(f)}`
        };
      });
  } catch { return []; }
}

// =========================================================================
//  TRANSLATION ENGINE
// =========================================================================
const translationCache = new Map();
const MAX_CACHE = 10000;

function getCached(text, lang) { return translationCache.get(text + '::' + lang) || null; }
function setCache(text, lang, translated) {
  if (translationCache.size > MAX_CACHE) {
    const first = translationCache.keys().next().value;
    translationCache.delete(first);
  }
  translationCache.set(text + '::' + lang, translated);
}

function translateText(text, targetLang, sourceLang) {
  return new Promise((resolve) => {
    if (!text || !text.trim() || text.length < 2 || text.length > 1000) return resolve(null);
    const sl  = sourceLang || 'auto';
    const q   = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${q}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const start = data.indexOf('[[[\"') + 4;
          if (start < 4) return resolve(null);
          const end = data.indexOf('"', start);
          if (end <= start) return resolve(null);
          let translated = data.substring(start, end)
            .replace(/\\n/g, '\n').replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\').replace(/\\/g, '/')
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          if (!translated || translated === text || translated.length > text.length * 5) return resolve(null);
          resolve(translated);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function detectLangFromIP(ip) {
  const countryLang = {
    VN:'vi', US:'en', GB:'en', AU:'en', CA:'en', JP:'ja', KR:'ko',
    CN:'zh', TW:'zh-TW', FR:'fr', DE:'de', ES:'es', IT:'it', PT:'pt',
    RU:'ru', PL:'pl', NL:'nl', TH:'th', ID:'id', MY:'ms', PH:'fil',
    SA:'ar', AE:'ar', TR:'tr', IN:'hi', BD:'bn', BR:'pt',
  };
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.'))
    return 'vi';
  return new Promise(resolve => {
    https.get(`https://ip-api.com/json/${ip}?fields=countryCode`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(countryLang[JSON.parse(d).countryCode] || 'en'); }
        catch { resolve('en'); }
      });
    }).on('error', () => resolve('en'));
  });
}

async function translateForAllUsers(text, sourceLang, excludeUserId) {
  const results = {};
  const needed  = new Set();
  for (const [uid, info] of onlineUsers.entries()) {
    if (uid === excludeUserId) continue;
    if (info.lang && info.lang !== sourceLang) needed.add(info.lang);
  }
  for (const lang of needed) {
    const cached = getCached(text, lang);
    if (cached) { results[lang] = cached; continue; }
    const translated = await translateText(text, lang, sourceLang);
    if (translated) { setCache(text, lang, translated); results[lang] = translated; }
  }
  return results;
}

// =========================================================================
//  SCHEMAS
// =========================================================================
const userSchema = new mongoose.Schema({
  username:      { type: String, unique: true, required: true },
  uuid:          { type: String, unique: true, sparse: true },
  password:      String,
  displayName:   { type: String, default: '' },
  avatar:        { type: String, default: '' },
  bio:           { type: String, default: '' },
  lang:          { type: String, default: 'vi' },
  isGameAccount: { type: Boolean, default: false },
  isOnline:      { type: Boolean, default: false },
  lastSeen:      { type: Date, default: Date.now },
  isAdmin:       { type: Boolean, default: false },
  status:        { type: String, default: 'active' },
  createdAt:     { type: Date, default: Date.now }
});

const postSchema = new mongoose.Schema({
  authorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName:   String,
  authorAvatar: String,
  content:      { type: String, required: true },
  originalLang: { type: String, default: 'vi' },
  translations: { type: Map, of: String, default: {} },
  image:        String,
  likes:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{
    authorId:     mongoose.Schema.Types.ObjectId,
    authorName:   String,
    authorAvatar: String,
    content:      String,
    translations: { type: Map, of: String, default: {} },
    createdAt:    { type: Date, default: Date.now }
  }],
  fromGame:  { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  roomId:       { type: String, required: true },
  senderId:     String,
  senderName:   String,
  senderAvatar: String,
  content:      { type: String, required: true },
  originalLang: { type: String, default: 'vi' },
  translations: { type: Map, of: String, default: {} },
  fromGame:     { type: Boolean, default: false },
  createdAt:    { type: Date, default: Date.now }
});

const User    = mongoose.model('User',    userSchema);
const Post    = mongoose.model('Post',    postSchema);
const Message = mongoose.model('Message', messageSchema);

// =========================================================================
//  MIDDLEWARE
// =========================================================================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

const adminAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(d.id);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    req.user = d; next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

function getRealIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.connection?.remoteAddress
      || req.ip || '127.0.0.1';
}

function sanitize(user) {
  const u = user.toObject ? user.toObject() : { ...user };
  delete u.password;
  return u;
}

// =========================================================================
//  ONLINE USERS
// =========================================================================
const onlineUsers = new Map(); // uid -> { socketId, lang, username }

// =========================================================================
//  SOCKET.IO
// =========================================================================
io.on('connection', async socket => {
  const clientIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
                || socket.handshake.address;
  socket.detectedLang = await detectLangFromIP(clientIP);

  socket.on('auth', async token => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      socket.userId = d.id;
      socket.join(d.id);
      socket.join('global');
      const user = await User.findByIdAndUpdate(d.id, { isOnline: true, lastSeen: new Date() }, { new: true });
      const lang = user?.lang || socket.detectedLang || 'vi';
      onlineUsers.set(d.id, { socketId: socket.id, lang, username: user?.username });
      io.emit('user_online', { userId: d.id });
    } catch {}
  });

  socket.on('set_lang', async ({ lang, token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      await User.findByIdAndUpdate(d.id, { lang });
      if (onlineUsers.has(d.id)) onlineUsers.get(d.id).lang = lang;
    } catch {}
  });

  socket.on('join_room', roomId => socket.join(roomId));

  socket.on('send_message', async ({ roomId, content, token }) => {
    try {
      const d    = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(d.id);
      if (!user) return;

      const senderLang   = user.lang || socket.detectedLang || 'vi';
      // Chỉ dịch khi gửi từ web → client (web→game)
      // Client→client KHÔNG dịch ở đây, client tự hiển thị ngôn ngữ gốc
      const translations = await translateForAllUsers(content, senderLang, d.id);

      const msg = await Message.create({
        roomId, senderId: d.id, content,
        senderName:   user.displayName || user.username,
        senderAvatar: user.avatar || '',
        originalLang: senderLang,
        translations,
      });

      // Phát bản dịch riêng cho từng user
      for (const [uid, info] of onlineUsers.entries()) {
        const sock = io.sockets.sockets.get(info.socketId);
        if (!sock) continue;
        const myLang      = info.lang || 'vi';
        const showText    = uid === d.id ? content : (translations[myLang] || content);
        const isTranslated = uid !== d.id && !!translations[myLang] && senderLang !== myLang;
        sock.emit('new_message', {
          _id: msg._id, roomId, content: showText,
          displayContent: showText,
          originalContent: content,
          originalLang: senderLang,
          isTranslated,
          senderId:     d.id,
          senderName:   msg.senderName,
          senderAvatar: msg.senderAvatar,
          fromGame: false,
          createdAt: msg.createdAt
        });
      }
    } catch(e) { console.error('send_message:', e.message); }
  });

  socket.on('disconnect', async () => {
    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
      io.emit('user_offline', { userId: socket.userId });
    }
  });
});

// =========================================================================
//  AUTH ROUTES
// =========================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password)        return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 3)           return res.status(400).json({ error: 'Username >= 3 ký tự' });
    if (password.length < 6)           return res.status(400).json({ error: 'Password >= 6 ký tự' });
    if (await User.findOne({ username })) return res.status(400).json({ error: 'Username đã tồn tại' });
    const ip   = getRealIP(req);
    const lang = await detectLangFromIP(ip);
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash, displayName: displayName || username, lang });
    const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: sanitize(user) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user)                                  return res.status(400).json({ error: 'Sai tài khoản/mật khẩu' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Sai mật khẩu' });
    const ip   = getRealIP(req);
    const lang = await detectLangFromIP(ip);
    await User.findByIdAndUpdate(user._id, { lang });
    const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...sanitize(user), lang } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// UUID login (từ Mindustry /webchat)
app.post('/api/auth/uuid', async (req, res) => {
  try {
    const { uuid, username } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
    const ip   = getRealIP(req);
    const lang = await detectLangFromIP(ip);
    let user = await User.findOne({ uuid });
    if (!user) {
      let finalUsername = username || 'Player_' + uuid.substring(0, 6);
      if (await User.findOne({ username: finalUsername }))
        finalUsername += '_' + Date.now().toString().slice(-4);
      const hash = await bcrypt.hash(uuid, 10);
      user = await User.create({ username: finalUsername, password: hash,
        displayName: username || finalUsername, uuid, isGameAccount: true, lang });
    } else {
      await User.findByIdAndUpdate(user._id, { lang });
    }
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...sanitize(user), lang } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// =========================================================================
//  PROFILE
// =========================================================================
app.put('/api/profile', auth, async (req, res) => {
  try {
    const { displayName, bio, avatar, lang } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName;
    if (bio !== undefined)         update.bio         = bio;
    if (avatar !== undefined)      update.avatar      = avatar;
    if (lang !== undefined)        update.lang        = lang;
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password');
    if (lang && onlineUsers.has(req.user.id)) onlineUsers.get(req.user.id).lang = lang;
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const user  = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    const posts = await Post.find({ authorId: user._id }).sort({ createdAt: -1 }).limit(20);
    res.json({ user, posts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/search', auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const users = await User.find({
      $or: [{ username: { $regex: q, $options: 'i' } },
            { displayName: { $regex: q, $options: 'i' } }]
    }).select('-password').limit(20);
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =========================================================================
//  POSTS
// =========================================================================
app.get('/api/posts', auth, async (req, res) => {
  try {
    const myLang = (await User.findById(req.user.id))?.lang || 'vi';
    const page   = parseInt(req.query.page) || 1;
    const posts  = await Post.find().sort({ createdAt: -1 }).skip((page-1)*20).limit(20);
    const result = posts.map(p => ({
      ...p.toObject(),
      displayContent: p.translations?.get?.(myLang) || p.content,
      isTranslated:   !!(p.translations?.get?.(myLang) && p.originalLang !== myLang)
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const { content, image } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const user       = await User.findById(req.user.id);
    const authorLang = user?.lang || 'vi';
    const translations = await translateForAllUsers(content, authorLang, req.user.id);
    const post = await Post.create({
      authorId: req.user.id, authorName: user.displayName || user.username,
      authorAvatar: user.avatar || '', content: content.trim(),
      originalLang: authorLang, translations, image: image || ''
    });
    for (const [uid, info] of onlineUsers.entries()) {
      const sock    = io.sockets.sockets.get(info.socketId);
      if (!sock) continue;
      const myLang  = info.lang || 'vi';
      const display = translations[myLang] || content;
      sock.emit('new_post', {
        ...post.toObject(),
        displayContent: display,
        isTranslated: !!(translations[myLang] && authorLang !== myLang)
      });
    }
    res.json(post);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const idx = post.likes.indexOf(req.user.id);
    if (idx >= 0) post.likes.splice(idx, 1); else post.likes.push(req.user.id);
    await post.save();
    io.emit('post_liked', { postId: post._id, likes: post.likes.length });
    res.json({ likes: post.likes.length, liked: idx < 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/comment', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const user       = await User.findById(req.user.id);
    const authorLang = user?.lang || 'vi';
    const translations = await translateForAllUsers(content, authorLang, req.user.id);
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const comment = {
      authorId: req.user.id, authorName: user.displayName || user.username,
      authorAvatar: user.avatar || '', content: content.trim(),
      originalLang: authorLang, translations
    };
    post.comments.push(comment);
    await post.save();
    io.emit('post_commented', { postId: post._id, comment, translations });
    res.json(post);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.authorId.toString() !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await post.deleteOne();
    io.emit('post_deleted', { postId: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =========================================================================
//  MESSAGES
// =========================================================================
app.get('/api/messages/:roomId', auth, async (req, res) => {
  try {
    const myLang = (await User.findById(req.user.id))?.lang || 'vi';
    const msgs   = await Message.find({ roomId: req.params.roomId })
      .sort({ createdAt: -1 }).limit(50);
    const result = msgs.reverse().map(m => ({
      ...m.toObject(),
      displayContent: m.senderId === req.user.id
        ? m.content
        : (m.translations?.get?.(myLang) || m.content),
      isTranslated: m.senderId !== req.user.id &&
        !!(m.translations?.get?.(myLang)) && m.originalLang !== myLang
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =========================================================================
//  GAME BRIDGE API (cho Mindustry ChatBridge.java)
// =========================================================================
app.post('/api/game/chat/send', async (req, res) => {
  try {
    const { uuid, username, content, lang: gameLang } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Empty' });
    const senderLang = gameLang || 'vi';

    let user = await User.findOne({ uuid });
    if (!user && username) {
      let fn = username;
      if (await User.findOne({ username: fn })) fn += '_g' + (uuid||'').substring(0,4);
      const hash = await bcrypt.hash(uuid || uuidv4(), 10);
      user = await User.create({ username: fn, password: hash,
        displayName: username, uuid, isGameAccount: true, lang: senderLang });
    }

    const senderName   = user?.displayName || user?.username || username || 'Game Player';
    const senderAvatar = user?.avatar || '';
    const senderId     = user?._id?.toString() || uuid || uuidv4();
    const translations = await translateForAllUsers(content, senderLang, null);

    const msg = await Message.create({
      roomId: 'global', senderId, senderName, senderAvatar,
      content, originalLang: senderLang, translations, fromGame: true
    });

    // Phát cho web users — bản dịch riêng cho từng người
    for (const [uid, info] of onlineUsers.entries()) {
      const sock   = io.sockets.sockets.get(info.socketId);
      if (!sock) continue;
      const myLang = info.lang || 'vi';
      const display = translations[myLang] || content;
      sock.emit('new_message', {
        _id: msg._id, roomId: 'global',
        content: display, displayContent: display,
        originalContent: content, originalLang: senderLang,
        isTranslated: !!(translations[myLang] && senderLang !== myLang),
        senderId, senderName, senderAvatar,
        fromGame: true, createdAt: msg.createdAt
      });
    }

    res.json({ success: true, messageId: msg._id, translatedTo: Object.keys(translations).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Poll tin nhắn mới từ web (cho plugin Java)
app.get('/api/game/chat/poll', async (req, res) => {
  try {
    const since    = req.query.since ? new Date(parseInt(req.query.since)) : new Date(Date.now() - 5000);
    const gameLang = req.query.lang || 'vi';
    const msgs = await Message.find({
      roomId: 'global', fromGame: false,
      createdAt: { $gt: since }
    }).sort({ createdAt: 1 }).limit(20);

    const result = [];
    for (const m of msgs) {
      let display = m.translations?.get?.(gameLang) || m.content;
      if (!m.translations?.get?.(gameLang) && gameLang !== m.originalLang) {
        const t = await translateText(m.content, gameLang, m.originalLang);
        if (t) {
          display = t;
          m.translations.set(gameLang, t);
          await m.save();
        }
      }
      result.push({
        _id: m._id, senderName: m.senderName, content: display,
        originalContent: m.content, originalLang: m.originalLang,
        isTranslated: display !== m.content, createdAt: m.createdAt
      });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/game/online', async (req, res) => {
  try {
    const users = await User.find({ isOnline: true })
      .select('username displayName uuid isGameAccount lang').limit(50);
    res.json({ count: users.length, users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/detect-lang', async (req, res) => {
  const ip   = getRealIP(req);
  const lang = await detectLangFromIP(ip);
  res.json({ lang, ip });
});

app.post('/api/translate', auth, async (req, res) => {
  try {
    const { text, targetLang, sourceLang } = req.body;
    const cached = getCached(text, targetLang);
    if (cached) return res.json({ translated: cached, cached: true });
    const translated = await translateText(text, targetLang, sourceLang || 'auto');
    if (translated) setCache(text, targetLang, translated);
    res.json({ translated: translated || text, cached: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =========================================================================
//  YOUTUBE SEARCH PROXY
//  Scrape ytInitialData từ YouTube search page — không cần API key
//  Tránh CORS bằng cách request từ server Node.js
// =========================================================================

/**
 * Scrape YouTube search results — parse ytInitialData từ HTML
 */
function scrapeYTSearch(q, maxResults = 16) {
  return new Promise(resolve => {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D`;
    const options = {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      }
    };

    https.get(searchUrl, options, res => {
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (html.length < 2000000) html += chunk; });
      res.on('end', () => {
        try {
          // Tìm ytInitialData trong script tag
          const marker = 'var ytInitialData = ';
          const start  = html.indexOf(marker);
          if (start < 0) { resolve([]); return; }

          // Extract JSON object bằng cách đếm ngoặc
          let depth = 0, i = start + marker.length;
          const jsonStart = i;
          for (; i < html.length; i++) {
            if (html[i] === '{') depth++;
            else if (html[i] === '}') { depth--; if (depth === 0) break; }
          }

          const data = JSON.parse(html.slice(jsonStart, i + 1));

          // Đi vào structure YouTube
          const contents =
            data?.contents?.twoColumnSearchResultsRenderer
                ?.primaryContents?.sectionListRenderer
                ?.contents?.[0]?.itemSectionRenderer
                ?.contents || [];

          const videos = [];
          for (const item of contents) {
            const vr = item.videoRenderer;
            if (!vr?.videoId) continue;

            videos.push({
              videoId:  vr.videoId,
              title:    vr.title?.runs?.[0]?.text || 'Unknown',
              channel:  vr.ownerText?.runs?.[0]?.text || '',
              thumb:    `https://i.ytimg.com/vi/${vr.videoId}/mqdefault.jpg`,
              duration: vr.lengthText?.simpleText || '',
              views:    vr.viewCountText?.simpleText || '',
            });

            if (videos.length >= maxResults) break;
          }

          resolve(videos);
        } catch(e) {
          console.error('[YT Proxy] parse err:', e.message);
          resolve([]);
        }
      });
    }).on('error', err => {
      console.error('[YT Proxy] fetch err:', err.message);
      resolve([]);
    });
  });
}

/** YouTube Suggest — fallback khi search rỗng */
function ytSuggest(q) {
  return new Promise(resolve => {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`;
    https.get(url, { headers:{'User-Agent':'Mozilla/5.0'} }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)[1] || []); } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// GET /api/yt/search?q=...&max=16
app.get('/api/yt/search', async (req, res) => {
  try {
    const q   = (req.query.q || '').trim();
    const max = Math.min(parseInt(req.query.max) || 16, 24);
    if (!q) return res.json({ videos: [], error: 'Missing query' });

    const videos = await scrapeYTSearch(q, max);

    if (!videos.length) {
      const suggestions = await ytSuggest(q);
      return res.json({ videos: [], suggestions, message: 'No results' });
    }

    res.json({ videos, total: videos.length });
  } catch(e) {
    console.error('[YT Search]', e.message);
    res.status(500).json({ error: e.message, videos: [] });
  }
});

// GET /api/yt/video/:videoId — embed info
app.get('/api/yt/video/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
    return res.status(400).json({ error: 'Invalid video ID' });
  res.json({
    videoId,
    embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`,
    thumb:    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    thumbMq:  `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
  });
});

// =========================================================================
//  MUSIC ASSETS ROUTES
// =========================================================================

// GET /api/music/list — danh sách file nhạc
app.get('/api/music/list', (req, res) => {
  const tracks = getMusicList();
  res.json({ tracks, count: tracks.length });
});

// GET /api/music/random — random 1 bài
app.get('/api/music/random', (req, res) => {
  const tracks = getMusicList();
  if (!tracks.length) return res.json({ track: null, message: 'No music in assets/music/' });
  res.json({ track: tracks[Math.floor(Math.random() * tracks.length)] });
});

// GET /api/music/stream/:filename — stream file với Range request support
app.get('/api/music/stream/:filename', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);

    // Security check — không cho path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\'))
      return res.status(400).json({ error: 'Invalid filename' });

    const ext = path.extname(filename).toLowerCase();
    if (!MUSIC_EXTS.includes(ext))
      return res.status(400).json({ error: 'File type not allowed' });

    const filePath = path.join(MUSIC_DIR, filename);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'File not found' });

    const stat        = fs.statSync(filePath);
    const fileSize    = stat.size;
    const contentType = MUSIC_MIME[ext] || 'audio/mpeg';
    const range       = req.headers.range;

    if (range) {
      // Partial Content — cho phép seek trên mobile
      const parts     = range.replace(/bytes=/, '').split('-');
      const start     = parseInt(parts[0], 10);
      const end       = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   contentType,
        'Cache-Control':  'public, max-age=3600',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   contentType,
        'Accept-Ranges':  'bytes',
        'Cache-Control':  'public, max-age=3600',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch(e) {
    console.error('[Music Stream]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// =========================================================================
//  ADMIN ROUTES
// =========================================================================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, isAdmin: true });
    if (!user) return res.status(400).json({ error: 'Không tìm thấy admin' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Sai mật khẩu' });
    const token = jwt.sign({ id: user._id, username, isAdmin: true }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await User.find({}).select('-password').sort({ createdAt: -1 });
  res.json(users);
});

app.put('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const { displayName, lang, status } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName;
    if (lang !== undefined)        update.lang        = lang;
    if (status !== undefined)      update.status      = status;
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/posts', adminAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const page  = parseInt(req.query.page)  || 1;
    const total = await Post.countDocuments();
    const posts = await Post.find().sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit);
    res.json({ posts, total, page });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/posts/:id', adminAuth, async (req, res) => {
  try {
    await Post.findByIdAndDelete(req.params.id);
    io.emit('post_deleted', { postId: req.params.id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/messages', adminAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const total = await Message.countDocuments({ roomId: 'global' });
    const msgs  = await Message.find({ roomId: 'global' }).sort({ createdAt: -1 }).limit(limit);
    res.json({ messages: msgs.reverse(), total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/messages/:id', adminAuth, async (req, res) => {
  try {
    await Message.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =========================================================================
//  INIT ADMIN
// =========================================================================
async function ensureAdmin() {
  const admin = await User.findOne({ isAdmin: true });
  if (!admin) {
    const hash = await bcrypt.hash('Admin@2024!', 10);
    await User.create({ username: 'admin', password: hash, displayName: 'Admin', isAdmin: true, lang: 'vi' });
    console.log('✅ Admin created: admin / Admin@2024!');
  }
}
mongoose.connection.once('open', ensureAdmin);

// =========================================================================
//  START
// =========================================================================
server.listen(PORT, () => {
  console.log(`🚀 abcxyz-offical-server on :${PORT}`);
  console.log(`🎵 Music dir: ${MUSIC_DIR}`);
  console.log(`   Bỏ file mp3/ogg vào assets/music/ để phát nhạc nền`);
  console.log(`🎬 YouTube proxy: GET /api/yt/search?q=...`);
});
