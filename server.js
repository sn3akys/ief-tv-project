const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const dbPath = path.join(__dirname, 'ief_tv_database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('=== ПОДКЛЮЧЕНИЕ К БД УСПЕШНО ===');
        db.run('PRAGMA journal_mode = WAL;', (pragmaErr) => {
            if (pragmaErr) console.error('Ошибка WAL:', pragmaErr);
            else console.log('База данных переведена в режим WAL');
        });
        initDatabaseStructure();
    }
});

function initDatabaseStructure() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            filename TEXT NOT NULL,
            type TEXT NOT NULL,
            upload_date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS playlist_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL,
            media_id INTEGER NOT NULL,
            sort_order INTEGER DEFAULT 0,
            settings_value INTEGER DEFAULT 10,
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS screens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            current_playlist_id INTEGER,
            FOREIGN KEY (current_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
        )`);
        console.log('Структура таблиц успешно создана');
    });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- МЕДИАТЕКА ---
app.get('/api/media', (req, res) => {
    db.all('SELECT * FROM media ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/media', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не прикреплен' });
    const title = req.body.title || req.file.originalname;
    const filename = req.file.filename;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'];
    const type = videoExtensions.includes(ext) ? 'video' : 'image';
    db.run('INSERT INTO media (title, filename, type) VALUES (?, ?, ?)', [title, filename, type], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/media/:id', (req, res) => {
    db.get('SELECT filename FROM media WHERE id = ?', [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Файл не найден' });
        const filePath = path.join(uploadDir, row.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        db.run('DELETE FROM media WHERE id = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// --- ПЛЕЙЛИСТЫ ---
app.get('/api/playlists', (req, res) => {
    db.all('SELECT * FROM playlists ORDER BY id ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/playlists', (req, res) => {
    if (!req.body.name) return res.status(400).json({ error: 'Имя не указано' });
    db.run('INSERT INTO playlists (name) VALUES (?)', [req.body.name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/playlists/:id', (req, res) => {
    db.run('DELETE FROM playlists WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/playlists/:id/items', (req, res) => {
    const query = `
        SELECT pi.id as item_id, pi.sort_order, pi.settings_value, m.title, m.type, m.filename
        FROM playlist_items pi
        JOIN media m ON pi.media_id = m.id
        WHERE pi.playlist_id = ?
        ORDER BY pi.sort_order ASC, pi.id ASC
    `;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/playlists/items', (req, res) => {
    const { playlist_id, media_id, settings_value } = req.body;
    if (!playlist_id || !media_id) return res.status(400).json({ error: 'Не переданы ID параметров' });
    db.get('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM playlist_items WHERE playlist_id = ?', [playlist_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const nextOrder = row.max_order + 1;
        db.run(
            'INSERT INTO playlist_items (playlist_id, media_id, settings_value, sort_order) VALUES (?, ?, ?, ?)',
            [playlist_id, media_id, settings_value || 10, nextOrder],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, item_id: this.lastID });
            }
        );
    });
});

app.put('/api/playlists/items/:id', (req, res) => {
    db.run('UPDATE playlist_items SET settings_value = ? WHERE id = ?', [req.body.settings_value, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.put('/api/playlists/items/:id/move', (req, res) => {
    const itemId = req.params.id;
    const { direction, playlist_id } = req.body;
    db.all('SELECT id, sort_order FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC, id ASC', [playlist_id], (err, items) => {
        if (err || items.length === 0) return res.status(500).json({ error: 'Очередь пуста' });
        const index = items.findIndex(item => item.id == itemId);
        if (index === -1) return res.status(404).json({ error: 'Элемент не найден' });
        let targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= items.length) return res.json({ success: true });
        const currentItem = items[index];
        const targetItem = items[targetIndex];
        db.serialize(() => {
            db.run('UPDATE playlist_items SET sort_order = ? WHERE id = ?', [targetItem.sort_order, currentItem.id]);
            db.run('UPDATE playlist_items SET sort_order = ? WHERE id = ?', [currentItem.sort_order, targetItem.id], () => {
                res.json({ success: true });
            });
        });
    });
});

app.delete('/api/playlists/items/:id', (req, res) => {
    db.run('DELETE FROM playlist_items WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- ЭКРАНЫ ---
app.get('/api/screens', (req, res) => {
    const query = `
        SELECT s.id, s.name, s.slug, s.current_playlist_id, p.name as playlist_name
        FROM screens s
        LEFT JOIN playlists p ON s.current_playlist_id = p.id
        ORDER BY s.id ASC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/screens', (req, res) => {
    const { name, slug } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Имя или Ключ не указаны' });
    const cleanSlug = slug.trim().toLowerCase().replace(/\s+/g, '-');
    db.run('INSERT INTO screens (name, slug) VALUES (?, ?)', [name.trim(), cleanSlug], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Экран с таким ключом уже существует' });
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

app.put('/api/screens/:id/playlist', (req, res) => {
    const { current_playlist_id } = req.body;
    const playlistId = current_playlist_id ? parseInt(current_playlist_id) : null;
    db.run('UPDATE screens SET current_playlist_id = ? WHERE id = ?', [playlistId, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/screens/:id', (req, res) => {
    db.run('DELETE FROM screens WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`\nСЕРВЕР «ИЭФ ТВ» СТАРТОВАЛ НА ПОРТУ ${PORT}`);
});