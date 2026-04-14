const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const multer     = require('multer');
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

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
  username:    { type: String, unique: true, required: true },
  uuid:        { type: String, unique: true, sparse: true },  // Mindustry UUID
  password:    String,
  displayName: { type: String, default: '' },
  avatar:      { type: String, default: '' },      // base64 hoac URL
  bio:         { type: String, default: '' },
  isGameAccount: { type: Boolean, default: false },
  isOnline:    { type: Boolean, default: false },
  lastSeen:    { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now }
});

const postSchema = new mongoose.Schema({
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName: String,
  authorAvatar: String,
  content:    { type: String, required: true },
  image:      String,
  likes:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments:   [{
    authorId:   mongoose.Schema.Types.ObjectId,
    authorName: String,
    authorAvatar: String,
    content:    String,
    createdAt:  { type: Date, default: Date.now }
  }],
  fromGame:   { type: Boolean, default: false },
  createdAt:  { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  roomId:     { type: String, required: true },   // 'global' | 'game' | userId_userId
  senderId:   String,
  senderName: String,
  senderAvatar: String,
  content:    { type: String, required: true },
  fromGame:   { type: Boolean, default: false },  // tin nhan tu Mindustry
  toGame:     { type: Boolean, default: false },  // se duoc relay len game
  readBy:     [String],
  createdAt:  { type: Date, default: Date.now }
});

const conversationSchema = new mongoose.Schema({
  participants: [String],   // array of userId strings
  lastMessage:  String,
  lastAt:       { type: Date, default: Date.now },
  unread:       { type: Map, of: Number, default: {} }
});

const User         = mongoose.model('User',         userSchema);
const Post         = mongoose.model('Post',         postSchema);
const Message      = mongoose.model('Message',      messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

// ==================== MIDDLEWARE ====================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ==================== SOCKET.IO ====================
const onlineUsers = new Map(); // userId -> socketId

io.on('connection', socket => {
  // Auth socket
  socket.on('auth', async token => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      socket.userId = d.id;
      socket.join(d.id);
      socket.join('global');
      onlineUsers.set(d.id, socket.id);
      await User.findByIdAndUpdate(d.id, { isOnline: true, lastSeen: new Date() });
      io.emit('user_online', { userId: d.id });
    } catch {}
  });

  socket.on('join_room', roomId => socket.join(roomId));

  socket.on('send_message', async ({ roomId, content, token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(d.id);
      if (!user) return;

      const msg = await Message.create({
        roomId, senderId: d.id, content,
        senderName:   user.displayName || user.username,
        senderAvatar: user.avatar || '',
        toGame: roomId === 'game' || roomId === 'global'
      });

      io.to(roomId).emit('new_message', {
        _id: msg._id, roomId, content,
        senderId:     d.id,
        senderName:   msg.senderName,
        senderAvatar: msg.senderAvatar,
        fromGame:     false,
        createdAt:    msg.createdAt
      });

      // Update conversation
      if (roomId !== 'global' && roomId !== 'game') {
        await Conversation.findOneAndUpdate(
          { participants: { $all: roomId.split('_') } },
          { lastMessage: content, lastAt: new Date() },
          { upsert: true }
        );
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

// ==================== AUTH ROUTES ====================
// Dang ky bang username/password
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 3)  return res.status(400).json({ error: 'Username >= 3 ky tu' });
    if (password.length < 6)  return res.status(400).json({ error: 'Password >= 6 ky tu' });
    if (await User.findOne({ username })) return res.status(400).json({ error: 'Username da ton tai' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash, displayName: displayName || username });
    const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { _id: user._id, username, displayName: user.displayName, avatar: user.avatar, bio: user.bio } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dang nhap bang username/password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'Sai tai khoan/mat khau' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Sai mat khau' });
    const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { _id: user._id, username, displayName: user.displayName, avatar: user.avatar, bio: user.bio } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dang nhap/dang ky bang Mindustry UUID (tu plugin ShopBank)
app.post('/api/auth/uuid', async (req, res) => {
  try {
    const { uuid, username } = req.body;
    if (!uuid) return res.status(400).json({ error: 'Missing uuid' });

    let user = await User.findOne({ uuid });
    if (!user) {
      // Tao tai khoan moi tu UUID
      let finalUsername = username || 'Player_' + uuid.substring(0, 6);
      const exists = await User.findOne({ username: finalUsername });
      if (exists) finalUsername = finalUsername + '_' + Date.now().toString().slice(-4);
      const hash = await bcrypt.hash(uuid, 10);
      user = await User.create({
        username: finalUsername, password: hash,
        displayName: username || finalUsername,
        uuid, isGameAccount: true
      });
    }
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { _id: user._id, username: user.username, displayName: user.displayName, avatar: user.avatar, bio: user.bio, uuid } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// ==================== PROFILE ROUTES ====================
app.put('/api/profile', auth, async (req, res) => {
  try {
    const { displayName, bio, avatar } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName;
    if (bio !== undefined)         update.bio         = bio;
    if (avatar !== undefined)      update.avatar      = avatar;
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password');
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    const posts = await Post.find({ authorId: user._id }).sort({ createdAt: -1 }).limit(20);
    res.json({ user, posts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/search', auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const users = await User.find({
      $or: [
        { username:    { $regex: q, $options: 'i' } },
        { displayName: { $regex: q, $options: 'i' } }
      ]
    }).select('-password').limit(20);
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== POSTS (FEED) ROUTES ====================
app.get('/api/posts', auth, async (req, res) => {
  try {
    const page   = parseInt(req.query.page) || 1;
    const limit  = 20;
    const posts  = await Post.find()
      .sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(limit);
    res.json(posts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts', auth, async (req, res) => {
  try {
    const { content, image } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const user = await User.findById(req.user.id);
    const post = await Post.create({
      authorId:     req.user.id,
      authorName:   user.displayName || user.username,
      authorAvatar: user.avatar || '',
      content: content.trim(),
      image:   image || ''
    });
    io.emit('new_post', post);
    res.json(post);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const idx = post.likes.indexOf(req.user.id);
    if (idx >= 0) post.likes.splice(idx, 1);
    else post.likes.push(req.user.id);
    await post.save();
    io.emit('post_liked', { postId: post._id, likes: post.likes.length });
    res.json({ likes: post.likes.length, liked: idx < 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/comment', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const user = await User.findById(req.user.id);
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const comment = {
      authorId:     req.user.id,
      authorName:   user.displayName || user.username,
      authorAvatar: user.avatar || '',
      content:      content.trim()
    };
    post.comments.push(comment);
    await post.save();
    io.emit('post_commented', { postId: post._id, comment });
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

// ==================== CHAT ROUTES ====================
// Lay messages cua 1 room
app.get('/api/messages/:roomId', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const msgs  = await Message.find({ roomId: req.params.roomId })
      .sort({ createdAt: -1 }).limit(limit);
    res.json(msgs.reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gui tin nhan (REST fallback)
app.post('/api/messages', auth, async (req, res) => {
  try {
    const { roomId, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
    const user = await User.findById(req.user.id);
    const msg  = await Message.create({
      roomId, senderId: req.user.id, content: content.trim(),
      senderName:   user.displayName || user.username,
      senderAvatar: user.avatar || '',
      toGame: roomId === 'global' || roomId === 'game'
    });
    io.to(roomId).emit('new_message', {
      _id: msg._id, roomId, content: msg.content,
      senderId: req.user.id,
      senderName: msg.senderName,
      senderAvatar: msg.senderAvatar,
      fromGame: false, createdAt: msg.createdAt
    });
    res.json(msg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== GAME BRIDGE API (cho Mindustry plugin) ====================

// Plugin poll tin nhan moi tu web de hien len game
app.get('/api/game/chat/poll', async (req, res) => {
  try {
    const since = req.query.since ? new Date(parseInt(req.query.since)) : new Date(Date.now() - 5000);
    const msgs  = await Message.find({
      roomId:  { $in: ['global', 'game'] },
      fromGame: false,
      createdAt: { $gt: since }
    }).sort({ createdAt: 1 }).limit(20);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Plugin push tin nhan tu game len web
app.post('/api/game/chat/send', async (req, res) => {
  try {
    const { uuid, username, content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Empty content' });

    // Tim hoac tao user
    let user = await User.findOne({ uuid });
    if (!user && username) {
      let finalUsername = username;
      const exists = await User.findOne({ username: finalUsername });
      if (exists) finalUsername = username + '_g' + uuid.substring(0, 4);
      const hash = await bcrypt.hash(uuid || uuidv4(), 10);
      user = await User.create({ username: finalUsername, password: hash, displayName: username, uuid, isGameAccount: true });
    }

    const displayName = user ? (user.displayName || user.username) : (username || 'Game Player');
    const avatar      = user?.avatar || '';

    const msg = await Message.create({
      roomId: 'global', senderId: user?._id?.toString() || uuid || uuidv4(),
      senderName: displayName, senderAvatar: avatar,
      content: content.trim(), fromGame: true
    });

    // Phat len tat ca web clients
    io.to('global').emit('new_message', {
      _id: msg._id, roomId: 'global', content: msg.content,
      senderId: msg.senderId, senderName: msg.senderName,
      senderAvatar: msg.senderAvatar,
      fromGame: true, createdAt: msg.createdAt
    });

    res.json({ success: true, messageId: msg._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Plugin lay danh sach nguoi dang online tren web
app.get('/api/game/online', async (req, res) => {
  try {
    const users = await User.find({ isOnline: true }).select('username displayName uuid isGameAccount').limit(50);
    res.json({ count: users.length, users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

server.listen(PORT, () => console.log(`🚀 CraborChat on :${PORT}`));
