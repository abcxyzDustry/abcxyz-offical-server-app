const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const https      = require('https');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://localhost:27017/craborchat';
const JWT_SECRET = process.env.JWT_SECRET || 'craborchat_secret_2024';
const PORT       = process.env.PORT       || 3000;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => console.error('MongoDB error:', e));

// =========================================================================
//  TRANSLATION ENGINE (port từ ChatTranslation.java)
// =========================================================================
const translationCache = new Map(); // "text::lang" -> translated
const MAX_CACHE = 10000;

function getCached(text, lang) {
  return translationCache.get(text + '::' + lang) || null;
}
function setCache(text, lang, translated) {
  if (translationCache.size > MAX_CACHE) {
    const first = translationCache.keys().next().value;
    translationCache.delete(first);
  }
  translationCache.set(text + '::' + lang, translated);
}

/** Google Translate free API — giống ChatTranslation.java */
function translateText(text, targetLang, sourceLang) {
  return new Promise((resolve) => {
    if (!text || !text.trim() || text.length < 2) return resolve(null);
    if (text.length > 1000) return resolve(null);

    const sl   = sourceLang || 'auto';
    const q    = encodeURIComponent(text);
    const url  = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${q}`;

    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          // Parse giống parseGoogleTranslateResponse trong ChatTranslation.java
          const start = data.indexOf('[[[\"') + 4;
          if (start < 4) return resolve(null);
          const end = data.indexOf('"', start);
          if (end <= start) return resolve(null);

          let translated = data.substring(start, end);
          // Unescape JSON
          translated = translated
            .replace(/\\n/g, '\n').replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\').replace(/\\/g, '/');
          // Decode unicode escapes
          translated = translated.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16)));

          if (!translated || translated === text || translated.length > text.length * 5)
            return resolve(null);

          resolve(translated);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

/** Detect ngon ngu tu IP bang ip-api.com (mien phi, khong can key) */
async function detectLangFromIP(ip) {
  // Fallback map quoc gia -> ngon ngu
  const countryLang = {
    VN:'vi', US:'en', GB:'en', AU:'en', CA:'en',
    JP:'ja', KR:'ko', CN:'zh', TW:'zh-TW',
    FR:'fr', DE:'de', ES:'es', IT:'it', PT:'pt',
    RU:'ru', PL:'pl', NL:'nl', SE:'sv', NO:'no',
    TH:'th', ID:'id', MY:'ms', PH:'fil',
    SA:'ar', AE:'ar', EG:'ar', TR:'tr',
    IN:'hi', BD:'bn', PK:'ur', BR:'pt',
    MX:'es', AR:'es', CO:'es', PE:'es',
  };

  // Bo qua localhost / private IP
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.'))
    return 'en';

  return new Promise(resolve => {
    https.get(`https://ip-api.com/json/${ip}?fields=countryCode`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(countryLang[j.countryCode] || 'en');
        } catch { resolve('en'); }
      });
    }).on('error', () => resolve('en'));
  });
}

/** Dich tin nhan sang tat ca ngon ngu dang online */
async function translateForAllUsers(text, sourceLang, excludeUserId) {
  const results = {}; // lang -> translated
  const needed  = new Set();

  // Lay danh sach ngon ngu can dich
  for (const [uid, info] of onlineUsers.entries()) {
    if (uid === excludeUserId) continue;
    if (info.lang && info.lang !== sourceLang) needed.add(info.lang);
  }

  for (const lang of needed) {
    const cached = getCached(text, lang);
    if (cached) {
      results[lang] = cached;
    } else {
      const translated = await translateText(text, lang, sourceLang);
      if (translated) {
        setCache(text, lang, translated);
        results[lang] = translated;
      }
    }
  }
  return results;
}

// =========================================================================
//  SCHEMAS
// =========================================================================
const userSchema = new mongoose.Schema({
  username:    { type: String, unique: true, required: true },
  uuid:        { type: String, unique: true, sparse: true },
  password:    String,
  displayName: { type: String, default: '' },
  avatar:      { type: String, default: '' },
  bio:         { type: String, default: '' },
  lang:        { type: String, default: 'en' }, // ngon ngu mac dinh
  isGameAccount: { type: Boolean, default: false },
  isOnline:    { type: Boolean, default: false },
  lastSeen:    { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now }
});

const postSchema = new mongoose.Schema({
  authorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName:   String,
  authorAvatar: String,
  content:      { type: String, required: true },
  originalLang: { type: String, default: 'en' },
  translations: { type: Map, of: String, default: {} }, // {vi: '...', ja: '...'}
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
  fromGame: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  roomId:       { type: String, required: true },
  senderId:     String,
  senderName:   String,
  senderAvatar: String,
  content:      { type: String, required: true },
  originalLang: { type: String, default: 'en' },
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

// Lay IP that (ho tro proxy / Render.com)
function getRealIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.connection?.remoteAddress
      || req.ip
      || '127.0.0.1';
}

// =========================================================================
//  ONLINE USERS: uid -> { socketId, lang, username }
// =========================================================================
const onlineUsers = new Map();

// =========================================================================
//  SOCKET.IO
// =========================================================================
io.on('connection', async socket => {
  // Detect ngon ngu tu IP ngay khi connect
  const clientIP   = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || socket.handshake.address;
  const detectedLang = await detectLangFromIP(clientIP);
  socket.detectedLang = detectedLang;

  socket.on('auth', async token => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      socket.userId = d.id;
      socket.join(d.id);
      socket.join('global');
      const user = await User.findByIdAndUpdate(d.id,
        { isOnline: true, lastSeen: new Date() }, { new: true });
      const lang = user?.lang || socket.detectedLang || 'en';
      onlineUsers.set(d.id, { socketId: socket.id, lang, username: user?.username });
      io.emit('user_online', { userId: d.id });
    } catch {}
  });

  // Client bao ngon ngu (khi doi setting)
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

      const senderLang  = user.lang || socket.detectedLang || 'en';
      const translations = await translateForAllUsers(content, senderLang, d.id);

      const msg = await Message.create({
        roomId, senderId: d.id, content,
        senderName:   user.displayName || user.username,
        senderAvatar: user.avatar || '',
        originalLang: senderLang,
        translations,
        toGame: roomId === 'global'
      });

      // Phat tung nguoi dung ban dich rieng
      for (const [uid, info] of onlineUsers.entries()) {
        const sock = io.sockets.sockets.get(info.socketId);
        if (!sock) continue;
        const myLang    = info.lang || 'en';
        const showText  = uid === d.id ? content
                        : (translations[myLang] || content);
        const isTranslated = uid !== d.id && !!translations[myLang];

        sock.emit('new_message', {
          _id: msg._id, roomId, content: showText,
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

      // Cap nhat conversation
      if (roomId !== 'global') {
        const parts = roomId.split('_');
        if (parts.length === 2)
          await mongoose.model('Conversation', new mongoose.Schema({
            participants: [String], lastMessage: String, lastAt: Date
          }, { strict: false })).findOneAndUpdate(
            { participants: { $all: parts } },
            { lastMessage: content, lastAt: new Date() },
            { upsert: true }
          ).catch(() => {});
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
//  AUTH
// =========================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 3) return res.status(400).json({ error: 'Username >= 3 ky tu' });
    if (password.length < 6) return res.status(400).json({ error: 'Password >= 6 ky tu' });
    if (await User.findOne({ username })) return res.status(400).json({ error: 'Username da ton tai' });
    // Detect lang tu IP
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
    if (!user) return res.status(400).json({ error: 'Sai tai khoan/mat khau' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Sai mat khau' });
    // Update lang tu IP
    const ip   = getRealIP(req);
    const lang = await detectLangFromIP(ip);
    await User.findByIdAndUpdate(user._id, { lang });
    const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { ...sanitize(user), lang } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dang nhap bang Mindustry UUID
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
    // Sync lang vao onlineUsers
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
    const myLang = (await User.findById(req.user.id))?.lang || 'en';
    const page   = parseInt(req.query.page) || 1;
    const posts  = await Post.find().sort({ createdAt: -1 }).skip((page-1)*20).limit(20);
    // Tra ve ban dich theo ngon ngu nguoi doc
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
    const authorLang = user?.lang || 'en';

    // Dich sang cac ngon ngu online
    const translations = await translateForAllUsers(content, authorLang, req.user.id);

    const post = await Post.create({
      authorId: req.user.id, authorName: user.displayName || user.username,
      authorAvatar: user.avatar || '', content: content.trim(),
      originalLang: authorLang, translations, image: image || ''
    });

    // Phat cho tung user ban dich rieng
    for (const [uid, info] of onlineUsers.entries()) {
      const sock     = io.sockets.sockets.get(info.socketId);
      if (!sock) continue;
      const myLang   = info.lang || 'en';
      const display  = translations[myLang] || content;
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
    const authorLang = user?.lang || 'en';
    const translations = await translateForAllUsers(content, authorLang, req.user.id);
    const post       = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const comment = { authorId: req.user.id, authorName: user.displayName || user.username,
      authorAvatar: user.avatar || '', content: content.trim(),
      originalLang: authorLang, translations };
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
    const myLang = (await User.findById(req.user.id))?.lang || 'en';
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

// Plugin push tin nhan tu game len web — co dich thuat
app.post('/api/game/chat/send', async (req, res) => {
  try {
    const { uuid, username, content, lang: gameLang } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Empty' });

    const senderLang = gameLang || 'en'; // Plugin co the gui kem lang

    // Tim / tao user
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

    // Dich sang tat ca ngon ngu online
    const translations = await translateForAllUsers(content, senderLang, null);

    const msg = await Message.create({
      roomId: 'global', senderId, senderName, senderAvatar,
      content, originalLang: senderLang, translations, fromGame: true
    });

    // Phat tung user ban dich rieng
    for (const [uid, info] of onlineUsers.entries()) {
      const sock   = io.sockets.sockets.get(info.socketId);
      if (!sock) continue;
      const myLang = info.lang || 'en';
      const display = translations[myLang] || content;
      sock.emit('new_message', {
        _id: msg._id, roomId: 'global',
        content: display, originalContent: content,
        originalLang: senderLang,
        isTranslated: !!(translations[myLang] && senderLang !== myLang),
        senderId, senderName, senderAvatar,
        fromGame: true, createdAt: msg.createdAt
      });
    }

    res.json({ success: true, messageId: msg._id, translatedTo: Object.keys(translations).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Plugin poll tin nhan moi tu web (da dich sang ngon ngu game)
app.get('/api/game/chat/poll', async (req, res) => {
  try {
    const since   = req.query.since ? new Date(parseInt(req.query.since)) : new Date(Date.now() - 5000);
    const gameLang = req.query.lang || 'en'; // Plugin gui kem ngon ngu can hien
    const msgs = await Message.find({
      roomId: 'global', fromGame: false,
      createdAt: { $gt: since }
    }).sort({ createdAt: 1 }).limit(20);

    // Tra ve ban dich theo ngon ngu game (hoac tu dich neu chua co)
    const result = [];
    for (const m of msgs) {
      let display = m.translations?.get?.(gameLang) || m.content;
      // Neu chua co ban dich cho ngon ngu nay thi dich them
      if (!m.translations?.get?.(gameLang) && gameLang !== m.originalLang) {
        const t = await translateText(m.content, gameLang, m.originalLang);
        if (t) {
          display = t;
          // Luu vao DB
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
    const users = await User.find({ isOnline: true }).select('username displayName uuid isGameAccount lang').limit(50);
    res.json({ count: users.length, users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// API detect ngon ngu tu IP (cho frontend)
app.get('/api/detect-lang', async (req, res) => {
  const ip   = getRealIP(req);
  const lang = await detectLangFromIP(ip);
  res.json({ lang, ip });
});

// API dich thu (client co the goi)
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
//  HELPERS
// =========================================================================
function sanitize(user) {
  const u = user.toObject ? user.toObject() : { ...user };
  delete u.password;
  return u;
}

server.listen(PORT, () => console.log(`🚀 CraborChat on :${PORT}`));
