require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Config ────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_KEY || process.env.GEMINI_KEY || '';
const MONGO_URI = process.env.MONGO_URI || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Models
const MODEL_TEXT   = 'llama-3.3-70b-versatile';           // text chat / planner
const MODEL_VISION = 'meta-llama/llama-4-scout-17b-16e-instruct'; // disease / food label
const MODEL_WHISPER = 'whisper-large-v3-turbo';           // voice transcription

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── MongoDB Connection (Vercel serverless lazy-cached pattern) ────
let _mongoPromise = null;
async function connectDB() {
    if (mongoose.connection.readyState === 1) return; // already connected
    if (!MONGO_URI) return;
    if (!_mongoPromise) {
        _mongoPromise = mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 30000,
        }).then(() => {
            console.log('  MongoDB connected');
        }).catch(err => {
            console.error('  MongoDB error:', err.message);
            _mongoPromise = null; // allow retry on next request
        });
    }
    await _mongoPromise;
}
if (MONGO_URI) { connectDB(); } else { console.warn('  MONGO_URI not set — DB features disabled'); }

// ═══════════════════════════════════════════════════════════
//  MONGOOSE MODELS
// ═══════════════════════════════════════════════════════════

// User
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

// Crop Listing (farmer puts crops for sale)
const ListingSchema = new mongoose.Schema({
    cropName: { type: String, required: true },
    qty: String,
    unit: String,
    price: Number,
    grade: { type: String, enum: ['A', 'B', 'C'], default: 'A' },
    farmerName: String,
    district: String,
    phone: String,
    lat: Number,
    lng: Number,
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
});
const Listing = mongoose.model('Listing', ListingSchema);

// Equipment Booking
const BookingSchema = new mongoose.Schema({
    equipmentId: Number,
    equipmentName: String,
    farmerName: String,
    farmerPhone: String,
    days: { type: Number, default: 1 },
    slot: String,
    totalPrice: Number,
    status: { type: String, enum: ['Requested', 'Confirmed', 'Active', 'Completed'], default: 'Requested' },
    startDate: Date,
    createdAt: { type: Date, default: Date.now },
});
const Booking = mongoose.model('Booking', BookingSchema);

// Market Price (crowdsourced)
const MarketPriceSchema = new mongoose.Schema({
    crop: { type: String, required: true },
    price: { type: Number, required: true },
    district: String,
    confirms: { type: Number, default: 1 },
    trend: { type: String, enum: ['up', 'down', 'flat'], default: 'flat' },
    sharedBy: String,
    createdAt: { type: Date, default: Date.now },
});
const MarketPrice = mongoose.model('MarketPrice', MarketPriceSchema);

// Delivery / Order
const DeliverySchema = new mongoose.Schema({
    orderId: String,
    cropName: String,
    fromDistrict: String,
    toDistrict: String,
    farmerName: String,
    farmerPhone: String,
    vehicleName: String,
    vehicleNumber: String,
    driverName: String,
    driverPhone: String,
    currentStep: { type: Number, default: 1 },
    status: { type: String, default: 'Pickup Requested' },
    eta: Number,
    createdAt: { type: Date, default: Date.now },
});
const Delivery = mongoose.model('Delivery', DeliverySchema);

// ── Blockchain Ledger Block ──────────────────────────────────
const LedgerBlockSchema = new mongoose.Schema({
    blockNumber:    { type: Number, required: true },
    orderId:        { type: String, required: true, index: true },
    productName:    { type: String, default: 'Crop' },
    farmerName:     { type: String, default: 'Farmer' },
    farmerWallet:   { type: String },
    buyerWallet:    { type: String },
    paymentAmount:  { type: Number, default: 0 },
    farmerShare:    { type: Number, default: 0 },
    platformShare:  { type: Number, default: 0 },
    deliveryStatus: { type: String },
    currentHash:    { type: String },
    previousHash:   { type: String },
    timestamp:      { type: Date, default: Date.now },
});
const LedgerBlock = mongoose.model('LedgerBlock', LedgerBlockSchema);

// Chat History
const ChatSchema = new mongoose.Schema({
    sessionId: String,
    lang: String,
    role: { type: String, enum: ['user', 'assistant'] },
    content: String,
    createdAt: { type: Date, default: Date.now },
});
const Chat = mongoose.model('Chat', ChatSchema);

// ═══════════════════════════════════════════════════════════
//  HELPER
// ═══════════════════════════════════════════════════════════
async function dbCheck(res) {
    await connectDB();
    if (mongoose.connection.readyState !== 1) {
        res.status(503).json({ error: 'Database not connected. Set MONGO_URI in .env' });
        return false;
    }
    return true;
}
async function groqPost(body) {
    const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = await r.json();
    if (result.error) console.error('GROQ API ERROR:', JSON.stringify(result.error, null, 2));
    return result;
}

// Whisper transcription for voice notes (WhatsApp / Voice Call)
async function whisperTranscribe(audioBuffer, mimeType) {
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', Buffer.from(audioBuffer), { filename: 'audio.ogg', contentType: mimeType || 'audio/ogg' });
    form.append('model', MODEL_WHISPER);
    form.append('language', 'en');
    const r = await fetch(GROQ_WHISPER_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, ...form.getHeaders() },
        body: form.getBuffer(),
    });
    const result = await r.json();
    return result.text || '';
}

// ── BLOCKCHAIN HELPERS ─────────────────────────────────────────
function sha256hex(data) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
}
const DELIVERY_STATUSES = ['Pickup Requested', 'Packed & Ready', 'In Transit', 'Arriving Soon', 'Delivered'];

function simulateLedger(orderId) {
    const seed = orderId.replace(/\D/g,'').padEnd(8,'0');
    const fw = `0xFA${seed.slice(0,4)}${seed.slice(4,8).toUpperCase()}`;
    const bw = `0xBU${seed.slice(2,6)}${seed.slice(0,4).toUpperCase()}`;
    let prevHash = '0'.repeat(64);
    return DELIVERY_STATUSES.map((status, i) => {
        const blockNumber = 4821000 + parseInt(seed.slice(0,5)||'0') + i;
        const timestamp   = new Date(Date.now() - (DELIVERY_STATUSES.length - i) * 7200000).toISOString();
        const amount      = 4500 + i * 300;
        const currentHash = sha256hex(`${blockNumber}${orderId}Crop${fw}${bw}${amount}${status}${prevHash}${timestamp}`);
        const block = { blockNumber, orderId, productName:'Crop', farmerName:'Farmer',
            farmerWallet:fw, buyerWallet:bw, paymentAmount:amount,
            farmerShare:Math.round(amount*0.75), platformShare:Math.round(amount*0.25),
            deliveryStatus:status, currentHash, previousHash:prevHash, timestamp };
        prevHash = currentHash;
        return block;
    });
}

async function createLedgerBlock({ orderId, productName='Crop', farmerName='Farmer', farmerWallet, buyerWallet, paymentAmount=0, deliveryStatus }) {
    if (mongoose.connection.readyState !== 1) return null;
    try {
        const [lastGlobal, lastOrder] = await Promise.all([
            LedgerBlock.findOne().sort({ blockNumber: -1 }),
            LedgerBlock.findOne({ orderId }).sort({ blockNumber: -1 }),
        ]);
        const blockNumber   = lastGlobal ? lastGlobal.blockNumber + 1 : 1;
        const previousHash  = lastOrder  ? lastOrder.currentHash  : '0'.repeat(64);
        const timestamp     = new Date().toISOString();
        const farmerShare   = Math.round(paymentAmount * 0.75);
        const platformShare = Math.round(paymentAmount * 0.25);
        const seed = orderId.replace(/\D/g,'').padEnd(8,'0');
        const fw = farmerWallet || `0xFA${seed.slice(0,4)}${seed.slice(4,8).toUpperCase()}`;
        const bw = buyerWallet  || `0xBU${seed.slice(2,6)}${seed.slice(0,4).toUpperCase()}`;
        const currentHash = sha256hex(`${blockNumber}${orderId}${productName}${fw}${bw}${paymentAmount}${deliveryStatus}${previousHash}${timestamp}`);
        return await LedgerBlock.create({
            blockNumber, orderId, productName, farmerName,
            farmerWallet:fw, buyerWallet:bw,
            paymentAmount, farmerShare, platformShare,
            deliveryStatus, currentHash, previousHash, timestamp,
        });
    } catch (e) { console.error('Ledger error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Health
app.get('/', (_req, res) => {
    res.send('<h1>✅ BELAI Backend API is successfully running!</h1><p>Visit <code>/api/health</code> to check system status.</p>');
});
app.get('/api/health', async (_req, res) => {
    await connectDB();
    res.json({ status: 'ok', service: 'BELAI Backend', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', time: new Date().toISOString() });
});

// ── LEDGER / BLOCKCHAIN ────────────────────────────────────────
app.get('/api/ledger/order/:orderId', async (req, res) => {
    try {
        await connectDB();
        const { orderId } = req.params;
        if (mongoose.connection.readyState !== 1) return res.json({ blocks: simulateLedger(orderId) });
        const blocks = await LedgerBlock.find({ orderId }).sort({ blockNumber: 1 });
        res.json({ blocks: blocks.length ? blocks : simulateLedger(orderId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ledger/search', async (req, res) => {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: 'orderId query param required' });
    try {
        await connectDB();
        if (mongoose.connection.readyState !== 1) return res.json({ blocks: simulateLedger(orderId) });
        const blocks = await LedgerBlock.find({ orderId }).sort({ blockNumber: 1 });
        res.json({ blocks: blocks.length ? blocks : simulateLedger(orderId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTH ──────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const existing = await User.findOne({ email: req.body.email });
        if (existing) return res.status(400).json({ error: 'User already exists' });
        const user = await User.create(req.body);
        res.status(201).json({ success: true, user: { id: user._id, name: user.name, email: user.email, phone: user.phone } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const user = await User.findOne({ email: req.body.email });
        if (!user || user.password !== req.body.password) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ success: true, user: { id: user._id, name: user.name, email: user.email, phone: user.phone } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ error: 'Google credential required' });

        // Verify token with Google
        const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
        const gData = await gRes.json();

        if (gData.error) return res.status(401).json({ error: 'Invalid Google token: ' + gData.error });

        const { email, name, picture, sub: googleId } = gData;
        if (!email) return res.status(401).json({ error: 'Could not retrieve email from Google' });

        // If DB connected: find or create user
        if (mongoose.connection.readyState === 1) {
            let user = await User.findOne({ email });
            if (!user) {
                user = await User.create({
                    name: name || email.split('@')[0],
                    email,
                    phone: '',
                    password: 'google-oauth-' + googleId,
                });
            }
            return res.json({
                success: true,
                user: { id: user._id, name: user.name, email: user.email, phone: user.phone, picture }
            });
        }

        // DB not connected — return profile from Google token directly
        res.json({
            success: true,
            user: { id: googleId, name: name || email.split('@')[0], email, phone: '', picture }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password required' });
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: 'No account found with this email' });
        user.password = newPassword;
        await user.save();
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LISTINGS ──────────────────────────────────────────────
app.get('/api/listings', async (_req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const listings = await Listing.find({ active: true }).sort({ createdAt: -1 }).limit(100);
        res.json(listings);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/listings', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const listing = await Listing.create(req.body);
        res.status(201).json(listing);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/listings/:id', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        await Listing.findByIdAndUpdate(req.params.id, { active: false });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BOOKINGS ──────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const q = req.query.phone ? { farmerPhone: req.query.phone } : {};
        const bookings = await Booking.find(q).sort({ createdAt: -1 });
        res.json(bookings);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookings', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const booking = await Booking.create(req.body);
        res.status(201).json(booking);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/bookings/:id/status', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const b = await Booking.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
        res.json(b);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MARKET PRICES ─────────────────────────────────────────
app.get('/api/market-prices', async (req, res) => {
    // Returns static + DB prices
    const STATIC = [
        { crop: 'Tomato', price: 1200, district: 'Kolar', trend: 'up', confirms: 12, img: '1546094096-0df4bcaaa337' },
        { crop: 'Paddy', price: 2200, district: 'Raichur', trend: 'flat', confirms: 8, img: '1536304993881-ff6e9eefa2a6' },
        { crop: 'Wheat', price: 2700, district: 'Dharwad', trend: 'up', confirms: 15, img: '1574323347407-f5e1ad6d020b' },
        { crop: 'Maize', price: 1900, district: 'Davanagere', trend: 'down', confirms: 7, img: '1601593346583-8f43c84e8f78' },
        { crop: 'Onion', price: 1500, district: 'Chitradurga', trend: 'down', confirms: 5, img: '1518977956812-cd3dbadaaf31' },
        { crop: 'Banana', price: 1200, district: 'Chamarajanagar', trend: 'up', confirms: 10, img: '1571771894821-ce9b6c11b08e' },
        { crop: 'Coffee', price: 8000, district: 'Chikkamagaluru', trend: 'up', confirms: 20, img: '1611854779393-1b2da9d400fe' },
        { crop: 'Coconut', price: 25, district: 'Tumakuru', trend: 'flat', confirms: 6, img: '1556909114-44e3e70034e2' },
    ];
    if (mongoose.connection.readyState !== 1) return res.json(STATIC);
    try {
        const dbPrices = await MarketPrice.find().sort({ createdAt: -1 }).limit(50);
        res.json([...STATIC, ...dbPrices]);
    } catch (e) { res.json(STATIC); }
});

app.post('/api/market-prices', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const mp = await MarketPrice.create(req.body);
        res.status(201).json(mp);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/market-prices/:id/confirm', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const mp = await MarketPrice.findByIdAndUpdate(req.params.id, { $inc: { confirms: 1 } }, { new: true });
        res.json(mp);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELIVERIES ────────────────────────────────────────────
app.get('/api/deliveries', async (_req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const deliveries = await Delivery.find().sort({ createdAt: -1 }).limit(50);
        res.json(deliveries);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deliveries', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const orderId = 'ORD' + Date.now();
        const delivery = await Delivery.create({ ...req.body, orderId });
        // Auto-create genesis ledger block (75/25 smart contract)
        createLedgerBlock({
            orderId,
            productName:    req.body.cropName   || 'Crop',
            farmerName:     req.body.farmerName  || 'Farmer',
            paymentAmount:  req.body.amount      || 5000,
            deliveryStatus: 'Pickup Requested',
        }).catch(() => {});
        res.status(201).json(delivery);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/deliveries/:id/step', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const d = await Delivery.findByIdAndUpdate(req.params.id, { currentStep: req.body.step, status: req.body.status }, { new: true });
        // Chain a new ledger block for every status change
        if (d) {
            createLedgerBlock({
                orderId:        d.orderId,
                productName:    d.cropName    || 'Crop',
                farmerName:     d.farmerName  || 'Farmer',
                paymentAmount:  d.amount      || 5000,
                deliveryStatus: req.body.status || d.status,
            }).catch(() => {});
        }
        res.json(d);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHAT HISTORY ──────────────────────────────────────────
app.get('/api/chat-history/:sessionId', async (req, res) => {
    if (!await dbCheck(res)) return;
    try {
        const history = await Chat.find({ sessionId: req.params.sessionId }).sort({ createdAt: 1 }).limit(30);
        res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AGRIBOT (with history saved) ─────────────────────────
const BELAI_SYSTEM = {
    en: "You are BELAI, a warm expert agricultural AI for Indian farmers. Give practical advice on crops, diseases, government schemes (PM-Kisan Rs.6000/year, PM Fasal Bima Yojana), Karnataka mandi prices. Use emojis. Keep under 130 words. End with one helpful follow-up question. Source: ICAR/Ministry of Agriculture. You MUST reply ONLY in English.",
    kn: "You are BELAI — Karnataka raitara AI sahayaka. You MUST reply ONLY in Kannada (ಕನ್ನಡ) script. NEVER reply in English. Bele, roga, sarkar yojane bagge advice kodi. Emojis balisiri. 130 padagalige miti. Follow-up prashne madi. ಕನ್ನಡದಲ್ಲಿ ಮಾತ್ರ ಉತ್ತರಿಸಿ.",
    te: "You are BELAI — Telugu raitulakai AI sahaayakudu. You MUST reply ONLY in Telugu (తెలుగు) script. NEVER reply in English. Emojis vaadandi. Follow-up question adugandi. తెలుగులో మాత్రమే సమాధానం ఇవ్వండి.",
    hi: "You are BELAI — Indian kisanon ke liye AI sahayak. You MUST reply ONLY in Hindi (हिन्दी) Devanagari script. NEVER reply in English. Fasal, bimari PM-Kisan Rs.6000/saal ke baare mein salah dijiye. Follow-up sawaal karein. हिन्दी में ही उत्तर दें.",
    ta: "You are BELAI — Tamil vivasaaigalukkaana AI utaviyaalar. You MUST reply ONLY in Tamil (தமிழ்) script. NEVER reply in English. Follow-up kelvigal keluungal. தமிழில் மட்டும் பதிலளிக்கவும்."
};

app.post('/api/agribot', async (req, res) => {
    try {
        const { lang = 'en', history = [], sessionId } = req.body;
        const systemPrompt = BELAI_SYSTEM[lang] || BELAI_SYSTEM.en;
        const messages = [{ role: 'system', content: systemPrompt }, ...history.slice(-8)];
        const data = await groqPost({ model: MODEL_TEXT, messages, max_tokens: 512, temperature: 0.7 });
        const reply = data.choices?.[0]?.message?.content || 'Unable to respond.';
        // Save to DB if connected
        if (sessionId && mongoose.connection.readyState === 1) {
            const last = history[history.length - 1];
            if (last?.role === 'user') await Chat.create({ sessionId, lang, role: 'user', content: last.content });
            await Chat.create({ sessionId, lang, role: 'assistant', content: reply });
        }
        res.json({ reply });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CROP PLANNER ──────────────────────────────────────────
app.post('/api/crop-planner', async (req, res) => {
    try {
        const { district, soil, season, rainfall } = req.body;
        const prompt = `District:${district},Soil:${soil},Season:${season},Rainfall:${rainfall}. Return ONLY valid JSON no markdown: {"crops":[{"name":"...","yield_per_acre":"...","msp_price":"...","water_need":"Low/Medium/High","growth_days":"...","roi_percent":"...","why":"..."}]} with 5 crops.`;
        const data = await groqPost({ model: MODEL_TEXT, messages: [{ role: 'system', content: 'You are expert Karnataka agronomist.' }, { role: 'user', content: prompt }], max_tokens: 800, temperature: 0.3 });
        let txt = data.choices?.[0]?.message?.content || '';
        txt = txt.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                res.json(JSON.parse(m[0]));
            } catch (err) {
                res.status(422).json({ error: 'JSON parse error', raw: txt });
            }
        } else {
            res.status(422).json({ error: 'Could not parse AI response', raw: txt });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DISEASE DETECTION (GEMINI 2.5 FLASH VISION — REAL TIME) ─────────────────────
app.post('/api/disease', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

        const prompt = 'Respond ONLY with a valid JSON object. No markdown, no backticks, no preamble.\nFormat must be exactly:\n{\n  "disease_name": "...",\n  "scientific_name": "...",\n  "confidence_percent": 85,\n  "severity": "Mild|Moderate|Severe|Healthy",\n  "affected_area_percent": 30,\n  "cause": "...",\n  "symptoms_observed": "...",\n  "treatment_steps": ["step1", "step2"],\n  "pesticides": [{"name":"...","dosage":"...","frequency":"..."}],\n  "organic_alternatives": "...",\n  "prevention_tips": "..."\n}';

        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ]
        }];

        const data = await groqPost({ model: MODEL_VISION, messages, max_tokens: 1000 });
        console.log('GROQ VISION RAW:', JSON.stringify(data, null, 2));
        let txt = data.choices?.[0]?.message?.content || '';
        const cleanTxt = txt.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

        try {
            res.json(JSON.parse(cleanTxt));
        } catch (err) {
            console.error('Failed to parse Gemini response', err, cleanTxt);
            // Fallback response instead of failing
            res.json({
                disease_name: "Unknown Leaf Disease",
                scientific_name: "Unidentified",
                confidence_percent: 0,
                severity: "Healthy",
                affected_area_percent: 0,
                cause: "Could not be analyzed.",
                symptoms_observed: "The image was not clearly identifiable.",
                treatment_steps: ["Please submit a clearer photo."],
                pesticides: [],
                organic_alternatives: "None identified",
                prevention_tips: "Taking a clear top-down photo in good lighting helps."
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── FOOD LABEL ────────────────────────────────────────────
app.post('/api/food-label', async (req, res) => {
    try {
        const { imageBase64, barcodeText } = req.body;
        let messages;
        if (barcodeText) {
            messages = [{ role: 'user', content: `Barcode: ${barcodeText}. Return ONLY JSON: {"productName":"...","brand":"...","mfgDate":"YYYY-MM-DD","expiryDate":"YYYY-MM-DD","batchNo":"...","daysUntilExpiry":100}` }];
        } else if (imageBase64) {
            messages = [{ role: 'user', content: [{ type: 'text', text: 'Read food label. Return ONLY JSON: {"productName":"...","brand":"...","mfgDate":"YYYY-MM-DD","expiryDate":"YYYY-MM-DD","batchNo":"...","daysUntilExpiry":100}' }, { type: 'image_url', image_url: { url: imageBase64 } }] }];
        } else return res.status(400).json({ error: 'imageBase64 or barcodeText required' });
        const model = MODEL_VISION;
        const data = await groqPost({ model, messages, max_tokens: 300 });
        let txt = data.choices?.[0]?.message?.content || '';
        txt = txt.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                res.json(JSON.parse(m[0]));
            } catch (err) {
                res.status(422).json({ error: 'JSON parse error', raw: txt });
            }
        } else {
            res.status(422).json({ error: 'Parse failed', raw: txt });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  OPTION 1: TWILIO AI VOICE CALL (IVR)
//  Flow: Farmer calls number → AI greets → Farmer speaks →
//        Gemini answers → spoken back to farmer via TTS
//  Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN in .env
// ══════════════════════════════════════════════════════════

// Twilio sends XML (TwiML) instructions — need urlencoded body parser
app.use('/api/voice', express.urlencoded({ extended: false }));

// Step 1: Twilio calls this when farmer dials your number
app.post('/api/voice/incoming', (req, res) => {
    const lang = req.body.To?.includes('kn') ? 'kn' : 'en'; // detect lang from number if configured
    const greet = {
        kn: 'Namaskara! Nanu BELAI — nimage bele sahaya maduttene. Nimage yaava prashne ide?',
        hi: 'Namaste! Main BELAI hoon — aapka krishi sahayak. Kya poochna chahte hain?',
        en: 'Hello! I am BELAI, your farming assistant. Please speak your farming question after the beep.',
    };
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="en-IN">${greet[lang] || greet.en}</Say>
  <Record action="/api/voice/respond" method="POST" maxLength="30" timeout="5" transcribe="false" playBeep="true"/>
  <Say voice="Polly.Aditi">Sorry, I did not hear you. Please call again.</Say>
</Response>`;
    res.type('text/xml').send(twiml);
});

// Step 2: Twilio sends the recorded audio URL — we transcribe + answer
app.post('/api/voice/respond', async (req, res) => {
    try {
        const recordingUrl = req.body.RecordingUrl;
        const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
        const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

        let farmerText = 'Tell me about crop diseases and how to treat them.'; // fallback

        // Transcribe via Twilio's built-in or Gemini
        if (TWILIO_SID && TWILIO_TOKEN && recordingUrl) {
            try {
                // Download audio and transcribe with Whisper
                const audioRes = await fetch(recordingUrl + '.wav', {
                    headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64') }
                });
                const audioBuffer = await audioRes.arrayBuffer();
                const transcribed = await whisperTranscribe(audioBuffer, 'audio/wav');
                if (transcribed) farmerText = transcribed;
            } catch (transcribeErr) {
                console.warn('Transcription fallback:', transcribeErr.message);
            }
        }

        // Get AI answer
        const aiData = await groqPost({
            model: MODEL_TEXT,
            messages: [
                { role: 'system', content: BELAI_SYSTEM.en + ' Keep response under 60 words, simple spoken language.' },
                { role: 'user', content: farmerText }
            ],
            max_tokens: 200,
            temperature: 0.7
        });
        const reply = (aiData.choices?.[0]?.message?.content || 'I could not understand. Please try again.')
            .replace(/[*#_`]/g, ''); // strip markdown for speech

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="en-IN">${reply}</Say>
  <Say voice="Polly.Aditi" language="en-IN">Do you have another question? Please call again. Thank you for using BELAI.</Say>
</Response>`;
        res.type('text/xml').send(twiml);
    } catch (e) {
        console.error('Voice respond error:', e.message);
        const errTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Sorry, there was an error. Please call again.</Say>
</Response>`;
        res.type('text/xml').send(errTwiml);
    }
});

// ══════════════════════════════════════════════════════════
//  OPTION 2: WHATSAPP VOICE MESSAGE AI BOT
//  Flow: Farmer sends WhatsApp voice note → Twilio webhook →
//        Backend downloads audio → Gemini transcribes →
//        Gemini answers → Text reply sent to farmer WhatsApp
//  Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN in .env
//  Setup: Point Twilio WhatsApp sandbox webhook to /api/whatsapp
// ══════════════════════════════════════════════════════════

app.use('/api/whatsapp', express.urlencoded({ extended: false }));

app.post('/api/whatsapp', async (req, res) => {
    const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

    const fromNumber  = req.body.From || '';        // e.g. whatsapp:+919876543210
    const bodyText    = (req.body.Body || '').trim();
    const numMedia    = parseInt(req.body.NumMedia || '0');
    const mediaUrl    = req.body.MediaUrl0 || '';   // audio file URL if voice note
    const mediaType   = req.body.MediaContentType0 || '';

    let farmerQuestion = bodyText;

    // If voice note received → transcribe it
    if (numMedia > 0 && mediaType.startsWith('audio') && mediaUrl && TWILIO_SID) {
        try {
            const audioRes = await fetch(mediaUrl, {
                headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64') }
            });
            const audioBuffer = await audioRes.arrayBuffer();
            const mimeType = mediaType.split(';')[0];

            // Transcribe with Groq Whisper
            const transcribed = await whisperTranscribe(audioBuffer, mimeType);
            farmerQuestion = transcribed || 'Tell me about farming tips.';
        } catch (err) {
            console.warn('WhatsApp audio transcription error:', err.message);
            farmerQuestion = 'Tell me about farming tips for Karnataka.';
        }
    }

    if (!farmerQuestion) {
        // Empty message — send welcome
        const welcomeTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🌾 Namaskara! I am BELAI — your AI farming assistant. Send me a voice note or type your farming question in any language (Kannada, Hindi, Telugu, English)!</Message>
</Response>`;
        return res.type('text/xml').send(welcomeTwiml);
    }

    try {
        // Get AI reply
        const aiData = await groqPost({
            model: MODEL_TEXT,
            messages: [
                { role: 'system', content: BELAI_SYSTEM.en + ' Keep response under 150 words. Use simple language for WhatsApp. Use emojis.' },
                { role: 'user', content: farmerQuestion }
            ],
            max_tokens: 300,
            temperature: 0.7
        });
        const reply = aiData.choices?.[0]?.message?.content
            || '🙏 Sorry, could not process your question. Please try again.';

        // Send reply back to farmer's WhatsApp
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🌾 *BELAI AgriBot*\n\n${reply}\n\n_Send another voice note or text for more help!_</Message>
</Response>`;
        res.type('text/xml').send(twiml);

        // Save to chat history if DB connected
        if (mongoose.connection.readyState === 1) {
            const sessionId = 'whatsapp_' + fromNumber.replace(/\D/g, '');
            await Chat.create({ sessionId, lang: 'en', role: 'user', content: farmerQuestion }).catch(() => {});
            await Chat.create({ sessionId, lang: 'en', role: 'assistant', content: reply }).catch(() => {});
        }
    } catch (e) {
        console.error('WhatsApp bot error:', e.message);
        const errTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>🙏 Sorry, I had a problem answering. Please try again!</Message>
</Response>`;
        res.type('text/xml').send(errTwiml);
    }
});

// ══════════════════════════════════════════════════════════
//  LITE MODE — Server-rendered HTML for keypad phones
//  Karbon K9, JioPhone, Nokia, Opera Mini — zero JavaScript
//  Routes: /lite  /lite/ask  /lite/prices  /lite/planner
//          /lite/schemes  /lite/tips
// ══════════════════════════════════════════════════════════

// Shared HTML shell for lite pages
function liteShell(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<meta name="HandheldFriendly" content="true"/>
<meta name="MobileOptimized" content="240"/>
<title>${title} - BELAI</title>
<link rel="icon" type="image/png" sizes="72x72" href="https://bel-ai.vercel.app/icons/icon-72.png"/>
<link rel="icon" type="image/png" sizes="192x192" href="https://bel-ai.vercel.app/icons/icon-192.png"/>
<link rel="shortcut icon" href="https://bel-ai.vercel.app/icons/icon-72.png"/>
<link rel="apple-touch-icon" href="https://bel-ai.vercel.app/icons/icon-192.png"/>
<meta name="theme-color" content="#0a1a0c"/>
<style>
body{background:#0a1a0c url('https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=600&q=40') center/cover fixed no-repeat;color:#fff;font-family:Arial,sans-serif;font-size:14px;margin:0;padding:0}
body::before{content:'';position:fixed;inset:0;background:rgba(5,15,5,0.88);z-index:0}
body>*{position:relative;z-index:1}
.wrap{padding:6px;max-width:480px;margin:0 auto}
h1{font-size:17px;color:#f5c842;text-align:center;margin:6px 0 2px;border-bottom:1px solid #2a4a2c;padding-bottom:6px}
h2{font-size:14px;color:#f5c842;margin:8px 0 4px}
h3{font-size:13px;color:#a3e635;margin:6px 0 3px}
p{margin:4px 0;line-height:1.5}
a{color:#f5c842;text-decoration:none}
a:visited{color:#d4a800}
.sub{font-size:11px;color:#88aa88;text-align:center;margin-bottom:8px}
.menu{background:#1a2e1c;border:1px solid #2a4a2c;padding:6px;margin-bottom:10px}
.mi{display:block;padding:10px 8px;border-bottom:1px solid #2a4a2c;color:#fff;font-size:13px;font-weight:bold}
.mi:last-child{border-bottom:none}
.ar{color:#f5c842;float:right}
form{margin:0;padding:0}
textarea,input[type=text],select{width:100%;background:#1a2e1c;border:1px solid #3a6a3c;color:#fff;font-size:13px;padding:8px;margin-bottom:8px;box-sizing:border-box}
input[type=submit]{background:#1a5e1c;border:2px solid #f5c842;color:#f5c842;font-size:14px;font-weight:bold;padding:10px;width:100%;cursor:pointer}
label{display:block;color:#88cc88;font-size:12px;margin-bottom:3px}
.ans{background:#0f2a10;border:1px solid #3a6a3c;border-left:3px solid #f5c842;padding:10px;margin:10px 0;font-size:13px;line-height:1.6}
.you{background:#1a1a00;border:1px solid #4a4a00;padding:8px;margin-bottom:8px;font-size:12px;color:#cccc88}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px}
th{background:#1a3e1c;color:#f5c842;padding:6px 4px;text-align:left;border-bottom:1px solid #3a6a3c;font-size:11px}
td{padding:7px 4px;border-bottom:1px solid #1a3a1c;vertical-align:top}
tr:nth-child(even) td{background:#0f1f10}
.up{color:#22c55e;font-weight:bold}
.dn{color:#ef4444;font-weight:bold}
.fl{color:#facc15}
.card{background:#1a2e1c;border:1px solid #2a4a2c;padding:8px;margin-bottom:8px}
.sch{background:#0f1a0f;border-left:2px solid #22c55e;padding:6px 8px;margin-bottom:8px;font-size:12px;line-height:1.5}
.tip{background:#0a1f1a;border-left:2px solid #f5c842;padding:6px 8px;margin-bottom:8px;font-size:13px;line-height:1.5}
.back{display:block;background:#1a2e1c;border:1px solid #2a4a2c;color:#f5c842;text-align:center;padding:9px;margin-bottom:10px;font-size:13px;font-weight:bold}
.foot{text-align:center;font-size:10px;color:#446644;margin-top:14px;padding-top:6px;border-top:1px solid #1a3a1c}
.err{color:#ef4444;font-size:12px}
.gn{color:#22c55e}
.gd{color:#f5c842}
hr{border:none;border-top:1px solid #1a3a1c;margin:10px 0}
</style>
</head>
<body>
<div class="wrap">
<h1>&#127807; BELAI Lite</h1>
<p class="sub">AI for Farmers | Keypad Mode</p>
${body}
<div class="foot">BELAI &bull; belai.vercel.app &bull; Works on all phones</div>
</div>
</body>
</html>`;
}

// ── /lite  — Home ─────────────────────────────────────────
// ── UI Translations for Lite Pages ───────────────────────
const UI = {
    en: {
        home: 'Home', askAI: 'Ask AI - Any Question', mandiPrices: 'Mandi Prices Today',
        cropPlanner: 'Crop Planner', govtSchemes: 'Govt Schemes (PM-Kisan)', farmTips: 'Quick Farming Tips',
        jioMsg: 'Using JioPhone?', jioDesc: 'This page works on ALL phones. No app needed. Type your farming question and get AI advice instantly.',
        backMenu: '← Back to Menu', askTitle: 'Ask BELAI AI', askDesc: 'Type your question in any language',
        yourLang: 'Your Language:', yourQ: 'Your Question:', getAnswer: 'Get AI Answer ►',
        quickQ: 'Quick questions:', yourQuestion: 'Your question:', belaiAnswer: 'BELAI Answer:',
        askAnother: 'Ask another question:', askAgain: 'Ask Again ►', typeNext: 'Type next question...',
        enterQ: 'Please type a question first.', tryAgain: 'Try Again',
        aiForFarmers: 'AI for Farmers', selectLang: 'Select Language:',
        placeholder: 'e.g. What fertilizer for tomato crop?',
    },
    kn: {
        home: 'ಮುಖಪುಟ', askAI: 'AI ಗೆ ಕೇಳಿ - ಯಾವುದೇ ಪ್ರಶ್ನೆ', mandiPrices: 'ಇಂದಿನ ಮಂಡಿ ಬೆಲೆಗಳು',
        cropPlanner: 'ಬೆಳೆ ಯೋಜಕ', govtSchemes: 'ಸರ್ಕಾರಿ ಯೋಜನೆಗಳು (PM-ಕಿಸಾನ್)', farmTips: 'ಕೃಷಿ ಸಲಹೆಗಳು',
        jioMsg: 'JioPhone ಬಳಸುತ್ತಿದ್ದೀರಾ?', jioDesc: 'ಈ ಪುಟ ಎಲ್ಲಾ ಫೋನ್‌ಗಳಲ್ಲಿ ಕೆಲಸ ಮಾಡುತ್ತದೆ. ನಿಮ್ಮ ಕೃಷಿ ಪ್ರಶ್ನೆ ಟೈಪ್ ಮಾಡಿ.',
        backMenu: '← ಮೆನುಗೆ ಹಿಂತಿರುಗಿ', askTitle: 'BELAI AI ಗೆ ಕೇಳಿ', askDesc: 'ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಟೈಪ್ ಮಾಡಿ',
        yourLang: 'ನಿಮ್ಮ ಭಾಷೆ:', yourQ: 'ನಿಮ್ಮ ಪ್ರಶ್ನೆ:', getAnswer: 'AI ಉತ್ತರ ಪಡೆಯಿರಿ ►',
        quickQ: 'ತ್ವರಿತ ಪ್ರಶ್ನೆಗಳು:', yourQuestion: 'ನಿಮ್ಮ ಪ್ರಶ್ನೆ:', belaiAnswer: 'BELAI ಉತ್ತರ:',
        askAnother: 'ಮತ್ತೊಂದು ಪ್ರಶ್ನೆ ಕೇಳಿ:', askAgain: 'ಮತ್ತೆ ಕೇಳಿ ►', typeNext: 'ಮುಂದಿನ ಪ್ರಶ್ನೆ ಟೈಪ್ ಮಾಡಿ...',
        enterQ: 'ದಯವಿಟ್ಟು ಮೊದಲು ಪ್ರಶ್ನೆ ಟೈಪ್ ಮಾಡಿ.', tryAgain: 'ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ',
        aiForFarmers: 'ರೈತರಿಗಾಗಿ AI', selectLang: 'ಭಾಷೆ ಆಯ್ಕೆ:',
        placeholder: 'ಉದಾ: ಟೊಮೆಟೊ ಬೆಳೆಗೆ ಯಾವ ಗೊಬ್ಬರ?',
    },
    hi: {
        home: 'होम', askAI: 'AI से पूछें - कोई भी सवाल', mandiPrices: 'आज की मंडी कीमतें',
        cropPlanner: 'फसल योजना', govtSchemes: 'सरकारी योजनाएं (PM-किसान)', farmTips: 'खेती की टिप्स',
        jioMsg: 'JioPhone इस्तेमाल कर रहे हैं?', jioDesc: 'यह पेज सभी फोन पर काम करता है। अपना खेती का सवाल टाइप करें।',
        backMenu: '← मेनू पर वापस', askTitle: 'BELAI AI से पूछें', askDesc: 'अपना सवाल टाइप करें',
        yourLang: 'आपकी भाषा:', yourQ: 'आपका सवाल:', getAnswer: 'AI जवाब पाएं ►',
        quickQ: 'जल्दी सवाल:', yourQuestion: 'आपका सवाल:', belaiAnswer: 'BELAI जवाब:',
        askAnother: 'और सवाल पूछें:', askAgain: 'फिर पूछें ►', typeNext: 'अगला सवाल टाइप करें...',
        enterQ: 'कृपया पहले सवाल टाइप करें।', tryAgain: 'फिर कोशिश करें',
        aiForFarmers: 'किसानों के लिए AI', selectLang: 'भाषा चुनें:',
        placeholder: 'उदा: टमाटर के लिए कौन सा खाद?',
    },
    te: {
        home: 'హోమ్', askAI: 'AI ని అడగండి - ఏదైనా ప్రశ్న', mandiPrices: 'నేటి మండి ధరలు',
        cropPlanner: 'పంట ప్లానర్', govtSchemes: 'ప్రభుత్వ పథకాలు (PM-కిసాన్)', farmTips: 'వ్యవసాయ చిట్కాలు',
        jioMsg: 'JioPhone వాడుతున్నారా?', jioDesc: 'ఈ పేజీ అన్ని ఫోన్‌లలో పనిచేస్తుంది. మీ వ్యవసాయ ప్రశ్న టైప్ చేయండి.',
        backMenu: '← మెనూకి తిరిగి', askTitle: 'BELAI AI ని అడగండి', askDesc: 'మీ ప్రశ్నను టైప్ చేయండి',
        yourLang: 'మీ భాష:', yourQ: 'మీ ప్రశ్న:', getAnswer: 'AI సమాధానం పొందండి ►',
        quickQ: 'త్వరిత ప్రశ్నలు:', yourQuestion: 'మీ ప్రశ్న:', belaiAnswer: 'BELAI సమాధానం:',
        askAnother: 'మరొక ప్రశ్న అడగండి:', askAgain: 'మళ్ళీ అడగండి ►', typeNext: 'తదుపరి ప్రశ్న టైప్ చేయండి...',
        enterQ: 'దయచేసి ముందుగా ప్రశ్న టైప్ చేయండి.', tryAgain: 'మళ్ళీ ప్రయత్నించండి',
        aiForFarmers: 'రైతుల కోసం AI', selectLang: 'భాష ఎంచుకోండి:',
        placeholder: 'ఉదా: టమాటో పంటకు ఏ ఎరువు?',
    },
    ta: {
        home: 'முகப்பு', askAI: 'AI யிடம் கேளுங்கள்', mandiPrices: 'இன்றைய மண்டி விலைகள்',
        cropPlanner: 'பயிர் திட்டமிடல்', govtSchemes: 'அரசு திட்டங்கள் (PM-கிசான்)', farmTips: 'விவசாய குறிப்புகள்',
        jioMsg: 'JioPhone பயன்படுத்துகிறீர்களா?', jioDesc: 'இந்த பக்கம் அனைத்து போன்களிலும் வேலை செய்யும். உங்கள் விவசாய கேள்வியை டைப் செய்யுங்கள்.',
        backMenu: '← மெனுவுக்கு திரும்பு', askTitle: 'BELAI AI யிடம் கேளுங்கள்', askDesc: 'உங்கள் கேள்வியை டைப் செய்யுங்கள்',
        yourLang: 'உங்கள் மொழி:', yourQ: 'உங்கள் கேள்வி:', getAnswer: 'AI பதில் பெறுங்கள் ►',
        quickQ: 'விரைவு கேள்விகள்:', yourQuestion: 'உங்கள் கேள்வி:', belaiAnswer: 'BELAI பதில்:',
        askAnother: 'மற்றொரு கேள்வி கேளுங்கள்:', askAgain: 'மீண்டும் கேளுங்கள் ►', typeNext: 'அடுத்த கேள்வியை டைப் செய்...',
        enterQ: 'தயவுசெய்து முதலில் கேள்வியை டைப் செய்யுங்கள்.', tryAgain: 'மீண்டும் முயற்சிக்கவும்',
        aiForFarmers: 'விவசாயிகளுக்கான AI', selectLang: 'மொழியை தேர்ந்தெடுக்கவும்:',
        placeholder: 'உதா: தக்காளிக்கு என்ன உரம்?',
    },
};
function t(lang, key) { return (UI[lang] && UI[lang][key]) || UI.en[key] || key; }

// ── /lite  — Home ─────────────────────────────────────────
app.get('/lite', (req, res) => {
    const lang = req.query.lang || 'en';
    const langLinks = ['en','kn','hi','te','ta'].map(l => {
        const names = {en:'English',kn:'ಕನ್ನಡ',hi:'हिन्दी',te:'తెలుగు',ta:'தமிழ்'};
        const active = l === lang ? 'font-weight:bold;background:#2a4a2c;' : '';
        return `<a href="/lite?lang=${l}" style="display:inline-block;padding:5px 10px;margin:2px;border:1px solid #3a6a3c;color:#f5c842;font-size:12px;${active}">${names[l]}</a>`;
    }).join('');

    res.type('text/html').send(liteShell(t(lang,'home'), `
<div style="text-align:center;margin-bottom:10px">
  <span style="font-size:11px;color:#88aa88">${t(lang,'selectLang')}</span><br/>
  ${langLinks}
</div>
<div class="menu">
  <a class="mi" href="/lite/ask?lang=${lang}">&#129302; ${t(lang,'askAI')} <span class="ar">&#9658;</span></a>
  <a class="mi" href="/lite/prices?lang=${lang}">&#128200; ${t(lang,'mandiPrices')} <span class="ar">&#9658;</span></a>
  <a class="mi" href="/lite/planner?lang=${lang}">&#127807; ${t(lang,'cropPlanner')} <span class="ar">&#9658;</span></a>
  <a class="mi" href="/lite/schemes?lang=${lang}">&#127963; ${t(lang,'govtSchemes')} <span class="ar">&#9658;</span></a>
  <a class="mi" href="/lite/tips?lang=${lang}">&#9889; ${t(lang,'farmTips')} <span class="ar">&#9658;</span></a>
</div>
<div class="card">
  <b class="gd">${t(lang,'jioMsg')}</b><br/>
  ${t(lang,'jioDesc')}
</div>
<div class="card">
  <b>PM-Kisan:</b> Rs.6000/year &bull;
  <b>Fasal Bima:</b> Crop insurance &bull;
  <b>eNAM:</b> Online mandi
</div>`));
});

// ── /lite/ask  — AI Chat Form ─────────────────────────────
app.get('/lite/ask', (req, res) => {
    const lang = req.query.lang || 'en';
    const langOpts = ['en','kn','hi','te','ta'].map(l => {
        const names = {en:'English',kn:'Kannada',hi:'Hindi',te:'Telugu',ta:'Tamil'};
        return `<option value="${l}"${l===lang?' selected':''}>${names[l]}</option>`;
    }).join('');
    const quickLinks = [
        ['PM-Kisan scheme details','PM-Kisan scheme details'],
        ['Tomato disease treatment','Tomato disease treatment'],
        ['Best crops for monsoon','Best crops for monsoon season in Karnataka'],
        ['Urea fertilizer dosage','Urea fertilizer dosage per acre'],
        ['Drip irrigation cost','Drip irrigation cost and subsidy'],
    ].map(([label,q]) =>
        `<a href="/lite/ask?lang=${lang}&q=${encodeURIComponent(q)}" style="display:inline-block;background:#1a3e1c;border:1px solid #2a5a2c;color:#a3e635;font-size:11px;padding:4px 7px;margin:2px 2px 2px 0">${label}</a>`
    ).join('');

    res.type('text/html').send(liteShell(t(lang,'askTitle'), `
<a class="back" href="/lite?lang=${lang}">${t(lang,'backMenu')}</a>
<h2>&#129302; ${t(lang,'askTitle')}</h2>
<p style="font-size:12px;color:#88cc88;margin-bottom:8px">${t(lang,'askDesc')}</p>
<p style="font-size:11px;color:#88aa88;margin-bottom:6px">${t(lang,'quickQ')}</p>
${quickLinks}
<hr/>
<form method="POST" action="/lite/ask">
  <input type="hidden" name="lang" value="${lang}"/>
  <label>${t(lang,'yourLang')}</label>
  <select name="lang">${langOpts}</select>
  <label>${t(lang,'yourQ')}</label>
  <textarea name="q" rows="4" placeholder="${t(lang,'placeholder')}">${req.query.q ? req.query.q : ''}</textarea>
  <input type="submit" value="${t(lang,'getAnswer')}"/>
</form>`));
});

app.post('/lite/ask', express.urlencoded({ extended: false }), async (req, res) => {
    const lang = req.body.lang || 'en';
    const question = (req.body.q || '').trim();
    if (!question) {
        return res.type('text/html').send(liteShell(t(lang,'askTitle'), `
<a class="back" href="/lite?lang=${lang}">${t(lang,'backMenu')}</a>
<p class="err">${t(lang,'enterQ')}</p>
<a class="back" href="/lite/ask?lang=${lang}">${t(lang,'tryAgain')}</a>`));
    }
    let reply = '';
    try {
        const langNames = {en:'English',kn:'Kannada',hi:'Hindi',te:'Telugu',ta:'Tamil'};
        const langName = langNames[lang] || 'English';
        const systemPrompt = BELAI_SYSTEM[lang] || BELAI_SYSTEM.en;
        const userMsg = lang === 'en' ? question : `[RESPOND IN ${langName.toUpperCase()} ONLY. DO NOT USE ENGLISH.]\n\n${question}`;
        const data = await groqPost({
            model: MODEL_TEXT,
            messages: [
                { role: 'system', content: systemPrompt + ' Keep answer under 100 words. Use simple text, no markdown symbols.' },
                { role: 'user', content: userMsg }
            ],
            max_tokens: 300,
            temperature: 0.7
        });
        reply = (data.choices?.[0]?.message?.content || 'Could not get answer. Please try again.')
            .replace(/[*#_`]/g, '').trim();
    } catch (e) {
        reply = 'Network error. Please try again in a few seconds.';
    }

    const langOpts = ['en','kn','hi','te','ta'].map(l => {
        const names = {en:'English',kn:'Kannada',hi:'Hindi',te:'Telugu',ta:'Tamil'};
        return `<option value="${l}"${l===lang?' selected':''}>${names[l]}</option>`;
    }).join('');

    res.type('text/html').send(liteShell(t(lang,'belaiAnswer'), `
<a class="back" href="/lite?lang=${lang}">${t(lang,'backMenu')}</a>
<div class="you"><b>${t(lang,'yourQuestion')}</b><br/>${question.replace(/</g,'&lt;')}</div>
<div class="ans"><b class="gd">&#129302; ${t(lang,'belaiAnswer')}</b><br/><br/>${reply.replace(/\n/g,'<br/>')}</div>
<hr/>
<h3>${t(lang,'askAnother')}</h3>
<form method="POST" action="/lite/ask">
  <select name="lang">${langOpts}</select>
  <textarea name="q" rows="3" placeholder="${t(lang,'typeNext')}"></textarea>
  <input type="submit" value="${t(lang,'askAgain')}"/>
</form>`));
});

// ── /lite/prices  — Market Prices ────────────────────────
app.get('/lite/prices', async (_req, res) => {
    const STATIC = [
        { crop:'Tomato',  price:1200, district:'Kolar',          trend:'up'   },
        { crop:'Paddy',   price:2200, district:'Raichur',        trend:'flat' },
        { crop:'Wheat',   price:2700, district:'Dharwad',        trend:'up'   },
        { crop:'Maize',   price:1900, district:'Davanagere',     trend:'down' },
        { crop:'Onion',   price:1500, district:'Chitradurga',    trend:'down' },
        { crop:'Banana',  price:1200, district:'Chamarajanagar', trend:'up'   },
        { crop:'Coffee',  price:8000, district:'Chikkamagaluru', trend:'up'   },
        { crop:'Coconut', price:25,   district:'Tumakuru',       trend:'flat' },
        { crop:'Ragi',    price:3578, district:'Mandya',         trend:'up'   },
        { crop:'Sugarcane',price:3200,district:'Belgaum',        trend:'flat' },
    ];
    let prices = STATIC;
    try {
        await connectDB();
        if (mongoose.connection.readyState === 1) {
            const db = await MarketPrice.find().sort({ createdAt:-1 }).limit(30);
            prices = [...STATIC, ...db];
        }
    } catch(e) {}

    const trendArrow = t => t==='up'?'<span class="up">&#9650; Up</span>':t==='down'?'<span class="dn">&#9660; Down</span>':'<span class="fl">&#8212; Flat</span>';
    const rows = prices.map(p =>
        `<tr><td><b>${p.crop}</b></td><td class="gd">Rs.${p.price}/q</td><td>${p.district||'KA'}</td><td>${trendArrow(p.trend)}</td></tr>`
    ).join('');
    const date = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});

    res.type('text/html').send(liteShell('Mandi Prices', `
<a class="back" href="/lite">&#8592; Back to Menu</a>
<h2>&#128200; Mandi Prices — ${date}</h2>
<p style="font-size:11px;color:#88aa88;margin-bottom:8px">Karnataka APMC prices (Rs. per quintal)</p>
<table>
  <tr><th>Crop</th><th>Price</th><th>District</th><th>Trend</th></tr>
  ${rows}
</table>
<div class="card" style="font-size:12px">
  <b class="gd">Share a price you know:</b>
  <form method="POST" action="/lite/prices/add">
    <input type="text" name="crop" placeholder="Crop name (e.g. Tomato)"/>
    <input type="text" name="price" placeholder="Price per quintal (e.g. 1500)"/>
    <input type="text" name="district" placeholder="Your district"/>
    <input type="submit" value="Share Price &#9658;"/>
  </form>
</div>
<p style="font-size:10px;color:#446644">Prices are indicative. Verify at local APMC before selling.</p>`));
});

app.post('/lite/prices/add', express.urlencoded({ extended: false }), async (req, res) => {
    const { crop, price, district } = req.body;
    if (crop && price) {
        try {
            await connectDB();
            if (mongoose.connection.readyState === 1) {
                await MarketPrice.create({ crop, price: parseFloat(price)||0, district: district||'Karnataka', trend:'flat', confirms:1 });
            }
        } catch(e) {}
    }
    res.redirect('/lite/prices');
});

// ── /lite/planner  — Crop Planner ─────────────────────────
app.get('/lite/planner', (_req, res) => {
    const districts = ['Bangalore Rural','Belagavi','Bellary','Bidar','Chamarajanagar','Chikkaballapur','Chikkamagaluru','Chitradurga','Dakshina Kannada','Davanagere','Dharwad','Gadag','Hassan','Haveri','Kalaburagi','Kodagu','Kolar','Koppal','Mandya','Mysuru','Raichur','Ramanagara','Shivamogga','Tumakuru','Udupi','Uttara Kannada','Vijayapura','Yadgir'];
    const distOpts = districts.map(d=>`<option value="${d}">${d}</option>`).join('');
    res.type('text/html').send(liteShell('Crop Planner', `
<a class="back" href="/lite">&#8592; Back to Menu</a>
<h2>&#127807; Crop Planner</h2>
<p style="font-size:12px;color:#88cc88;margin-bottom:8px">Enter your farm details — AI suggests best crops</p>
<form method="POST" action="/lite/planner">
  <label>District:</label>
  <select name="district">${distOpts}</select>
  <label>Soil Type:</label>
  <select name="soil">
    <option>Red Soil</option>
    <option>Black Cotton Soil</option>
    <option>Sandy Loam</option>
    <option>Clay Soil</option>
    <option>Laterite Soil</option>
    <option>Alluvial Soil</option>
  </select>
  <label>Season:</label>
  <select name="season">
    <option>Kharif (June-Oct)</option>
    <option>Rabi (Nov-Mar)</option>
    <option>Summer (Mar-Jun)</option>
  </select>
  <label>Irrigation:</label>
  <select name="rainfall">
    <option>Rainfed only</option>
    <option>Borewell irrigated</option>
    <option>Canal irrigated</option>
    <option>Drip irrigation</option>
  </select>
  <input type="submit" value="Get Crop Recommendations &#9658;"/>
</form>`));
});

app.post('/lite/planner', express.urlencoded({ extended: false }), async (req, res) => {
    const { district='Kolar', soil='Red Soil', season='Kharif', rainfall='Rainfed only' } = req.body;
    let crops = [];
    try {
        const prompt = `District:${district}, Soil:${soil}, Season:${season}, Water:${rainfall}. Give top 5 crops. Return ONLY valid JSON: {"crops":[{"name":"...","yield":"...","price":"...","days":"...","why":"..."}]}`;
        const data = await groqPost({
            model: MODEL_TEXT,
            messages: [
                { role:'system', content:'You are expert Karnataka agronomist. Return only valid JSON, no markdown.' },
                { role:'user', content: prompt }
            ],
            max_tokens: 600,
            temperature: 0.3
        });
        let txt = (data.choices?.[0]?.message?.content||'').replace(/```(?:json)?\s*/gi,'').replace(/```/g,'').trim();
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) crops = JSON.parse(m[0]).crops || [];
    } catch(e) {
        crops = [
            {name:'Tomato',yield:'8-12 tonnes/acre',price:'Rs.800-2000/q',days:'90-120',why:'High demand, good for '+district},
            {name:'Ragi',yield:'8-10 q/acre',price:'Rs.3578/q MSP',days:'110-130',why:'Drought tolerant, suited for Karnataka'},
            {name:'Groundnut',yield:'6-8 q/acre',price:'Rs.5550/q MSP',days:'100-120',why:'Good for sandy loam soils'},
        ];
    }

    const rows = crops.map((c,i) => `
<div class="card">
  <b class="gd">${i+1}. ${c.name}</b><br/>
  <span style="font-size:11px">
    <b>Yield:</b> ${c.yield||'-'} &bull;
    <b>Price:</b> ${c.price||'-'}<br/>
    <b>Duration:</b> ${c.days||'-'} days<br/>
    <span style="color:#88cc88">${c.why||''}</span>
  </span>
</div>`).join('');

    res.type('text/html').send(liteShell('Crop Recommendations', `
<a class="back" href="/lite/planner">&#8592; New Plan</a>
<a class="back" href="/lite">&#8962; Home</a>
<h2>&#127807; Recommended Crops</h2>
<p style="font-size:11px;color:#88aa88;margin-bottom:8px">
  ${district} &bull; ${soil} &bull; ${season}
</p>
${rows}
<div class="tip">
  <b>Tip:</b> Check PM-Kisan and Fasal Bima Yojana before sowing.
  <a href="/lite/schemes">View Schemes &#9658;</a>
</div>`));
});

// ── /lite/schemes  — Govt Schemes ────────────────────────
app.get('/lite/schemes', (_req, res) => {
    res.type('text/html').send(liteShell('Govt Schemes', `
<a class="back" href="/lite">&#8592; Back to Menu</a>
<h2>&#127963; Government Schemes for Farmers</h2>

<div class="sch">
  <b class="gd">1. PM-Kisan Samman Nidhi</b><br/>
  Rs.6000 per year (Rs.2000 x 3 instalments)<br/>
  Who: All small &amp; marginal farmers with land<br/>
  Apply: pmkisan.gov.in or nearest CSC centre<br/>
  Helpline: <b>155261</b>
</div>

<div class="sch">
  <b class="gd">2. PM Fasal Bima Yojana (PMFBY)</b><br/>
  Crop insurance at low premium (2% Kharif, 1.5% Rabi)<br/>
  Covers: Drought, flood, pest, hailstorm damage<br/>
  Apply: Through bank or pmfby.gov.in<br/>
  Deadline: Before sowing season
</div>

<div class="sch">
  <b class="gd">3. Kisan Credit Card (KCC)</b><br/>
  Loan up to Rs.3 lakh at 4% interest per year<br/>
  For: Seeds, fertilizers, equipment purchase<br/>
  Apply: Any nationalized bank branch<br/>
  Bring: Land documents + Aadhaar card
</div>

<div class="sch">
  <b class="gd">4. PM Kisan Mandhan Yojana (Pension)</b><br/>
  Rs.3000/month pension after age 60<br/>
  Who: Farmers aged 18-40 years<br/>
  Premium: Rs.55-200/month depending on age<br/>
  Apply: CSC centre with Aadhaar + bank passbook
</div>

<div class="sch">
  <b class="gd">5. Soil Health Card (SHC)</b><br/>
  Free soil testing for your farm<br/>
  Get: Fertilizer recommendations for your soil<br/>
  Apply: Contact nearest Krishi Vigyan Kendra (KVK)
</div>

<div class="sch">
  <b class="gd">6. eNAM — National Agriculture Market</b><br/>
  Sell crops online at best price<br/>
  Register: enam.gov.in<br/>
  Available in: 1000+ mandis across India
</div>

<hr/>
<div class="card" style="font-size:12px">
  <b>Karnataka Specific:</b><br/>
  Raita Siri Scheme &bull; HDMC Subsidy &bull; Zero Interest Loans<br/>
  Contact: Rayata Samparka Kendra (RSK) in your taluk<br/>
  Helpline: <b>1800-425-1422</b> (Karnataka Agriculture)
</div>

<a class="back" href="/lite/ask?q=Tell+me+about+PM-Kisan+scheme+eligibility+and+how+to+apply">
  &#129302; Ask AI about any scheme &#9658;
</a>`));
});

// ── /lite/tips  — Quick Tips ──────────────────────────────
app.get('/lite/tips', (_req, res) => {
    res.type('text/html').send(liteShell('Farming Tips', `
<a class="back" href="/lite">&#8592; Back to Menu</a>
<h2>&#9889; Quick Farming Tips</h2>

<div class="tip">
  <b>&#127774; Soil Preparation</b><br/>
  Deep plough (20-25cm) before Kharif. Add 10 tonnes FYM per acre. Test soil every 3 years at KVK.
</div>

<div class="tip">
  <b>&#128167; Water Management</b><br/>
  Drip irrigation saves 40-50% water. Ideal for tomato, chilli, sugarcane. Govt subsidy available (90% for SC/ST, 50% others).
</div>

<div class="tip">
  <b>&#127804; Disease Early Warning</b><br/>
  Yellow leaves = nutrient deficiency or virus. Brown spots = fungal. Apply neem oil (5ml/litre) as organic spray first.
</div>

<div class="tip">
  <b>&#128200; Best Time to Sell</b><br/>
  Avoid selling right after harvest when prices are lowest. Store in cold storage or SHG warehouses. Prices rise 30-40% in 2 months.
</div>

<div class="tip">
  <b>&#127807; Ragi Tips (Karnataka)</b><br/>
  MSP: Rs.3578/quintal. Sow June-July. Spacing: 22.5 x 10cm. Apply 60:30:30 NPK per acre. Resistant to drought.
</div>

<div class="tip">
  <b>&#127813; Tomato Tips</b><br/>
  Raised bed planting. Apply DAP 100kg + Urea 50kg per acre. Stake at 30cm height. Spray copper fungicide for blight.
</div>

<div class="tip">
  <b>&#127807; Organic Farming</b><br/>
  Vermicompost (1 tonne/acre) replaces 50% chemical fertilizer. Sell as "Organic" for 20-30% premium price.
</div>

<hr/>
<a class="back" href="/lite/ask">&#129302; Ask AI for more tips &#9658;</a>
<a class="back" href="/lite/planner">&#127807; Plan my crops &#9658;</a>`));
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  🌾 BELAI Backend → http://localhost:${PORT}`);
    console.log(`  Health          → http://localhost:${PORT}/api/health`);
    console.log(`  Lite Mode       → http://localhost:${PORT}/lite`);
    console.log(`  Voice Call      → POST /api/voice/incoming`);
    console.log(`  WhatsApp Bot    → POST /api/whatsapp`);
    console.log(`  MongoDB → ${MONGO_URI ? 'configured' : 'NOT SET (add MONGO_URI to .env)'}\n`);
});
