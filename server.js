const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024
});

// ── Static files ──
app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'remote.html')));

const sessions = {};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se aceptan archivos PDF'));
  }
});

app.post('/api/session', (req, res) => {
  const sessionId = uuidv4().substr(0, 8).toUpperCase();
  sessions[sessionId] = {
    displaySocket: null,
    remoteSocket: null,
    pdfData: null,
    currentPage: 1,
    totalPages: 0,
    notes: {},
    darkMode: true
  };
  setTimeout(() => { delete sessions[sessionId]; }, 3 * 60 * 60 * 1000);
  res.json({ sessionId });
});

app.post('/api/upload/:sessionId', upload.single('pdf'), (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió el PDF' });
  session.pdfData = req.file.buffer.toString('base64');
  session.currentPage = 1;
  res.json({ ok: true, size: req.file.size });
  if (session.displaySocket) {
    session.displaySocket.emit('pdf-ready', { pdfData: session.pdfData, currentPage: 1 });
  }
});

io.on('connection', (socket) => {

  socket.on('join-display', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) { socket.emit('error', 'Sesión no encontrada'); return; }
    session.displaySocket = socket;
    socket.sessionId = sessionId;
    socket.role = 'display';
    socket.emit('joined', { role: 'display', sessionId });
    if (session.pdfData) {
      socket.emit('pdf-ready', { pdfData: session.pdfData, currentPage: session.currentPage });
    }
    if (session.remoteSocket) session.remoteSocket.emit('display-connected');
  });

  socket.on('join-remote', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) { socket.emit('error', 'Sesión no encontrada. Revisa el código.'); return; }
    session.remoteSocket = socket;
    socket.sessionId = sessionId;
    socket.role = 'remote';
    socket.emit('joined', { role: 'remote', sessionId });
    if (session.displaySocket) socket.emit('display-connected');
  });

  socket.on('change-slide', ({ delta }) => {
    const session = sessions[socket.sessionId];
    if (!session || socket.role !== 'remote') return;
    const next = session.currentPage + delta;
    if (next < 1 || next > session.totalPages) return;
    session.currentPage = next;
    if (session.displaySocket) session.displaySocket.emit('go-to-page', { page: session.currentPage });
    socket.emit('page-changed', { page: session.currentPage });
  });

  socket.on('go-to-page', ({ page }) => {
    const session = sessions[socket.sessionId];
    if (!session || socket.role !== 'remote') return;
    if (page < 1 || page > session.totalPages) return;
    session.currentPage = page;
    if (session.displaySocket) session.displaySocket.emit('go-to-page', { page });
    socket.emit('page-changed', { page });
  });

  socket.on('report-pages', ({ totalPages, currentPage }) => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    session.totalPages = totalPages;
    session.currentPage = currentPage;
    if (session.remoteSocket) session.remoteSocket.emit('page-info', { totalPages, currentPage });
  });

  socket.on('laser-move', ({ x, y }) => {
    const session = sessions[socket.sessionId];
    if (!session || socket.role !== 'remote') return;
    if (session.displaySocket) session.displaySocket.emit('laser-move', { x, y });
  });

  socket.on('laser-off', () => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    if (session.displaySocket) session.displaySocket.emit('laser-off');
  });

  socket.on('save-note', ({ page, text }) => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    session.notes[page] = text;
    socket.emit('note-saved', { page });
  });

  socket.on('get-note', ({ page }) => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    socket.emit('note-data', { page, text: session.notes[page] || '' });
  });

  socket.on('toggle-dark', () => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    session.darkMode = !session.darkMode;
    if (session.displaySocket) session.displaySocket.emit('set-dark', { dark: session.darkMode });
    socket.emit('dark-updated', { dark: session.darkMode });
  });

  socket.on('disconnect', () => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    if (socket.role === 'display') {
      session.displaySocket = null;
      if (session.remoteSocket) session.remoteSocket.emit('display-disconnected');
    } else if (socket.role === 'remote') {
      session.remoteSocket = null;
      if (session.displaySocket) session.displaySocket.emit('remote-disconnected');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ SlideBeam corriendo en http://localhost:${PORT}`);
});
