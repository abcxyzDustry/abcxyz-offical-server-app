const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const axios = require('axios');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: '*' },
    maxHttpBufferSize: 1e6
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// ==================== CONFIG ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/craborchat';
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(64).toString('hex');
const PORT = process.env.PORT || 3000;

// Cache dịch thuật (TTL 24 giờ)
const translationCache = new NodeCache({ stdTTL: 86400, maxKeys: 10000 });

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    uuid: { type: String, unique: true, sparse: true },
    password: String,
    displayName: { type: String, default: '' },
    avatar: { type: String, default: '' },
    bio: { type: String, default: '' },
    preferredLanguage: { type: String, default: 'en' },
    detectedLanguage: { type: String, default: 'en' },
    lastIp: { type: String, default: '' },
    isGameAccount: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
    roomId: { type: String, required: true },
    senderId: String,
    senderName: String,
    senderAvatar: String,
    originalContent: { type: String, required: true },
    translatedContent: { type: Map, of: String },
    sourceLanguage: { type: String, default: 'auto' },
    fromGame: { type: Boolean, default: false },
    toGame: { type: Boolean, default: false },
    readBy: [String],
    createdAt: { type: Date, default: Date.now, index: true }
});

// Indexes for performance
messageSchema.index({ roomId: 1, createdAt: -1 });
messageSchema.index({ fromGame: 1, createdAt: 1 });
messageSchema.index({ createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// ==================== KẾT NỐI MONGODB ====================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(e => console.error('❌ MongoDB error:', e));

// ==================== DỊCH THUẬT UTILITY (GIỐNG PLUGIN) ====================
async function translateText(text, sourceLang, targetLang) {
    if (!text || text.trim().length === 0) return text;
    if (sourceLang === targetLang) return text;
    if (sourceLang === 'auto') sourceLang = 'en';
    
    // Check cache
    const cacheKey = `${text}|${sourceLang}|${targetLang}`;
    const cached = translationCache.get(cacheKey);
    if (cached) return cached;
    
    try {
        // Sử dụng Google Translate API (unofficial) giống plugin
        const encodedText = encodeURIComponent(text);
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodedText}`;
        
        const response = await axios.get(url, {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (response.data && response.data[0] && response.data[0][0] && response.data[0][0][0]) {
            const translated = response.data[0][0][0];
            if (translated && translated !== text) {
                translationCache.set(cacheKey, translated);
                console.log(`✅ Translated: ${text} (${sourceLang}) -> ${translated} (${targetLang})`);
                return translated;
            }
        }
    } catch (error) {
        console.error('Translation error:', error.message);
    }
    
    return text;
}

// ==================== SOCKET.IO ====================
const onlineUsers = new Map();

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    socket.on('auth', async (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.userId = decoded.id;
            socket.join(decoded.id);
            socket.join('global');
            onlineUsers.set(decoded.id, socket.id);
            await User.findByIdAndUpdate(decoded.id, { isOnline: true, lastSeen: new Date() });
            io.emit('user_online', { userId: decoded.id });
            console.log('✅ User authenticated:', decoded.id);
        } catch (err) {
            console.error('Auth error:', err.message);
        }
    });
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        console.log(`📢 ${socket.id} joined room: ${roomId}`);
    });
    
    socket.on('send_message', async ({ roomId, content, token }) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (!user) return;
            
            const msg = await Message.create({
                roomId,
                senderId: decoded.id,
                senderName: user.displayName || user.username,
                senderAvatar: user.avatar || '',
                originalContent: content,
                sourceLanguage: user.preferredLanguage || 'en',
                fromGame: false,
                toGame: roomId === 'game' || roomId === 'global'
            });
            
            io.to(roomId).emit('new_message', {
                _id: msg._id,
                roomId,
                originalContent: content,
                sourceLanguage: msg.sourceLanguage,
                senderId: decoded.id,
                senderName: msg.senderName,
                senderAvatar: msg.senderAvatar,
                fromGame: false,
                createdAt: msg.createdAt
            });
            
        } catch (err) {
            console.error('Send message error:', err.message);
        }
    });
    
    socket.on('disconnect', async () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
            await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
            io.emit('user_offline', { userId: socket.userId });
            console.log('🔌 User disconnected:', socket.userId);
        }
    });
});

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, displayName } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
        if (username.length < 3) return res.status(400).json({ error: 'Username >= 3 characters' });
        if (password.length < 6) return res.status(400).json({ error: 'Password >= 6 characters' });
        
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: 'Username already exists' });
        
        const hash = await bcrypt.hash(password, 10);
        const user = await User.create({
            username,
            password: hash,
            displayName: displayName || username
        });
        
        const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            token,
            user: {
                _id: user._id,
                username,
                displayName: user.displayName,
                avatar: user.avatar,
                bio: user.bio,
                preferredLanguage: user.preferredLanguage
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: 'Invalid credentials' });
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ id: user._id, username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            token,
            user: {
                _id: user._id,
                username,
                displayName: user.displayName,
                avatar: user.avatar,
                bio: user.bio,
                preferredLanguage: user.preferredLanguage
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/uuid', async (req, res) => {
    try {
        const { uuid, username, language } = req.body;
        if (!uuid) return res.status(400).json({ error: 'Missing uuid' });
        
        let user = await User.findOne({ uuid });
        if (!user) {
            let finalUsername = username || 'Player_' + uuid.substring(0, 6);
            const exists = await User.findOne({ username: finalUsername });
            if (exists) finalUsername = finalUsername + '_' + Date.now().toString().slice(-4);
            
            const hash = await bcrypt.hash(uuid, 10);
            user = await User.create({
                username: finalUsername,
                password: hash,
                displayName: username || finalUsername,
                uuid,
                isGameAccount: true,
                preferredLanguage: language || 'en'
            });
        }
        
        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            token,
            user: {
                _id: user._id,
                username: user.username,
                displayName: user.displayName,
                avatar: user.avatar,
                bio: user.bio,
                uuid,
                preferredLanguage: user.preferredLanguage
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== GAME BRIDGE API (QUAN TRỌNG) ====================

// Poll tin nhắn từ web để gửi lên game
app.get('/api/game/chat/poll', async (req, res) => {
    try {
        const since = req.query.since ? new Date(parseInt(req.query.since)) : new Date(Date.now() - 5000);
        const gameLang = req.query.lang || 'en';
        
        const messages = await Message.find({
            roomId: { $in: ['global', 'game'] },
            fromGame: false,
            createdAt: { $gt: since }
        }).sort({ createdAt: 1 }).limit(30);
        
        // Dịch tin nhắn sang ngôn ngữ game yêu cầu
        const translatedMessages = await Promise.all(messages.map(async (msg) => {
            let translated = msg.translatedContent?.get(gameLang);
            
            if (!translated && msg.originalContent) {
                translated = await translateText(msg.originalContent, msg.sourceLanguage, gameLang);
                msg.translatedContent = msg.translatedContent || new Map();
                msg.translatedContent.set(gameLang, translated);
                await msg.save();
            }
            
            return {
                _id: msg._id,
                senderName: msg.senderName,
                originalContent: msg.originalContent,
                translatedContent: translated || msg.originalContent,
                sourceLanguage: msg.sourceLanguage,
                createdAt: msg.createdAt
            };
        }));
        
        res.json(translatedMessages);
        
    } catch (err) {
        console.error('Poll error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Nhận tin nhắn từ game
app.post('/api/game/chat/send', async (req, res) => {
    try {
        const { uuid, username, originalContent, translatedContent, sourceLang, targetLang } = req.body;
        
        if (!originalContent?.trim()) {
            return res.status(400).json({ error: 'Empty content' });
        }
        
        // Tìm hoặc tạo user
        let user = await User.findOne({ uuid });
        if (!user && username) {
            let finalUsername = username;
            const exists = await User.findOne({ username: finalUsername });
            if (exists) finalUsername = username + '_' + uuid.substring(0, 4);
            
            const hash = await bcrypt.hash(uuid || uuidv4(), 10);
            user = await User.create({
                username: finalUsername,
                password: hash,
                displayName: username,
                uuid,
                isGameAccount: true,
                preferredLanguage: sourceLang || 'en'
            });
        }
        
        const displayName = user ? (user.displayName || user.username) : (username || 'Game Player');
        const avatar = user?.avatar || '';
        
        // Lưu message
        const translations = new Map();
        if (translatedContent && targetLang) {
            translations.set(targetLang, translatedContent);
        }
        
        const msg = await Message.create({
            roomId: 'global',
            senderId: user?._id?.toString() || uuid,
            senderName: displayName,
            senderAvatar: avatar,
            originalContent: originalContent,
            translatedContent: translations,
            sourceLanguage: sourceLang || 'auto',
            fromGame: true,
            toGame: false
        });
        
        // Phát lên web clients
        io.to('global').emit('new_message', {
            _id: msg._id,
            roomId: 'global',
            originalContent: msg.originalContent,
            sourceLanguage: msg.sourceLanguage,
            senderId: msg.senderId,
            senderName: msg.senderName,
            senderAvatar: msg.senderAvatar,
            fromGame: true,
            createdAt: msg.createdAt
        });
        
        console.log(`📨 Game message from ${displayName}: ${originalContent}`);
        res.json({ success: true, messageId: msg._id });
        
    } catch (err) {
        console.error('Game send error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Lấy danh sách online
app.get('/api/game/online', async (req, res) => {
    try {
        const users = await User.find({ isOnline: true })
            .select('username displayName uuid isGameAccount preferredLanguage')
            .limit(50);
        res.json({ count: users.length, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== PROFILE ROUTES ====================
const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

app.get('/api/auth/me', auth, async (req, res) => {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
});

app.put('/api/profile/language', auth, async (req, res) => {
    try {
        const { language } = req.body;
        if (!language) return res.status(400).json({ error: 'Language required' });
        
        const user = await User.findByIdAndUpdate(
            req.user.id,
            { preferredLanguage: language },
            { new: true }
        ).select('-password');
        
        res.json({ success: true, preferredLanguage: user.preferredLanguage });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== START SERVER ====================
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║     🦀 CRABORCHAT SERVER STARTED SUCCESSFULLY     ║
╠═══════════════════════════════════════════════════╣
║  Port: ${PORT}                                       ║
║  MongoDB: ${MONGO_URI.includes('localhost') ? 'Local' : 'Remote'}        ║
║  Translation: Google Translate API (unofficial)   ║
║  Cache: 10,000 entries / 24h TTL                  ║
╚═══════════════════════════════════════════════════╝
    `);
});
