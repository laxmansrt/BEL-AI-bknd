require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 4000;

// ── Config ────────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_KEY || '';
const MONGO_URI = process.env.MONGO_URI || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

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
    return r.json();
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
    en: "You are BELAI, a warm expert agricultural AI for Indian farmers. Give practical advice on crops, diseases, government schemes (PM-Kisan Rs.6000/year, PM Fasal Bima Yojana), Karnataka mandi prices. Use emojis. Keep under 130 words. End with one helpful follow-up question. Source: ICAR/Ministry of Agriculture.",
    kn: "Neevu BELAI — Karnataka raitara AI sahayaka. Bele, roga, sarkar yojane bagge advice kodi. Emojis balisiri. 130 padagalige miti. Follow-up prashne madi.",
    te: "Meeru BELAI — Telugu raitulakai AI sahaayakudu. Emojis vaadandi. Follow-up question adugandi.",
    hi: "Main BELAI hoon — Indian kisanon ke liye AI sahayak. Fasal, bimari PM-Kisan Rs.6000/saal ke baare mein salah dijiye. Follow-up sawaal karein.",
    ta: "Naan BELAI — Tamil vivasaaigalukkaana AI utaviyaalar. Follow-up kelvigal keluungal."
};

app.post('/api/agribot', async (req, res) => {
    try {
        const { lang = 'en', history = [], sessionId } = req.body;
        const systemPrompt = BELAI_SYSTEM[lang] || BELAI_SYSTEM.en;
        const messages = [{ role: 'system', content: systemPrompt }, ...history.slice(-8)];
        const data = await groqPost({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 512, temperature: 0.7 });
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
        const data = await groqPost({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: 'You are expert Karnataka agronomist.' }, { role: 'user', content: prompt }], max_tokens: 800, temperature: 0.3 });
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Could not parse AI response', raw: txt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DISEASE DETECTION (ML SERVICE) ─────────────────────────
app.post('/api/disease', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

        // Forward the image to our dedicated Python AI Model (MobileNetV2 CNN)
        const mlResponse = await fetch('http://localhost:8000/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64 })
        });

        if (!mlResponse.ok) {
            const errText = await mlResponse.text();
            throw new Error(`ML Service Error: ${errText}`);
        }

        const result = await mlResponse.json();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message, info: 'Make sure the Python ML service is running on port 8000.' });
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
        const model = imageBase64 ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
        const data = await groqPost({ model, messages, max_tokens: 300 });
        const txt = data.choices?.[0]?.message?.content || '';
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) res.json(JSON.parse(m[0]));
        else res.status(422).json({ error: 'Parse failed', raw: txt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  🌾 BELAI Backend → http://localhost:${PORT}`);
    console.log(`  Health  → http://localhost:${PORT}/api/health`);
    console.log(`  MongoDB → ${MONGO_URI ? 'configured' : 'NOT SET (add MONGO_URI to .env)'}\n`);
});
