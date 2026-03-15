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
  maxHttpBufferSize: 50 * 1024 * 1024 // 50 MB for PDF uploads
});

// ── Static files ──
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── In-memory sessions ──
// sessions[sessionId] = { displaySocket, remoteSocket, pdfData, currentPage, totalPages, notes, darkMode }
const sessions = {};

// ── Multer: store PDF in memory ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se aceptan archivos PDF'));
  }
});

// ── REST: Create session ──
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
  // Clean up session after 3 hours
  setTimeout(() => { delete sessions[sessionId]; }, 3 * 60 * 60 * 1000);
  res.json({ sessionId });
});

// ── REST: Upload PDF ──
app.post('/api/upload/:sessionId', upload.single('pdf'), (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió el PDF' });

  // Store PDF as base64 so we can send it via Socket.io
  session.pdfData = req.file.buffer.toString('base64');
  session.currentPage = 1;

  res.json({ ok: true, size: req.file.size });

  // Notify display that PDF is ready
  if (session.displaySocket) {
    session.displaySocket.emit('pdf-ready', {
      pdfData: session.pdfData,
      currentPage: 1
    });
  }
});

// ── Socket.io ──
io.on('connection', (socket) => {

  // Display screen joins
  socket.on('join-display', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) { socket.emit('error', 'Sesión no encontrada'); return; }

    session.displaySocket = socket;
    socket.sessionId = sessionId;
    socket.role = 'display';

    socket.emit('joined', { role: 'display', sessionId });

    // If remote already uploaded a PDF, send it immediately
    if (session.pdfData) {
      socket.emit('pdf-ready', { pdfData: session.pdfData, currentPage: session.currentPage });
    }

    // Tell remote that display is connected
    if (session.remoteSocket) {
      session.remoteSocket.emit('display-connected');
    }
  });

  // Remote (phone) joins
  socket.on('join-remote', ({ sessionId }) => {
    const session = sessions[sessionId];
    if (!session) { socket.emit('error', 'Sesión no encontrada. Revisa el código.'); return; }

    session.remoteSocket = socket;
    socket.sessionId = sessionId;
    socket.role = 'remote';

    socket.emit('joined', { role: 'remote', sessionId });

    if (session.displaySocket) {
      socket.emit('display-connected');
    }
  });

  // Remote → change slide
  socket.on('change-slide', ({ delta }) => {
    const session = sessions[socket.sessionId];
    if (!session || socket.role !== 'remote') return;

    const next = session.currentPage + delta;
    if (next < 1 || next > session.totalPages) return;

    session.currentPage = next;

    if (session.displaySocket) {
      session.displaySocket.emit('go-to-page', { page: session.currentPage });
    }
    socket.emit('page-changed', { page: session.currentPage });
  });

  // Remote → go to specific page
  socket.on('go-to-page', ({ page }) => {
    const session = sessions[socket.sessionId];
    if (!session || socket.role !== 'remote') return;
    if (page < 1 || page > session.totalPages) return;

    session.currentPage = page;
    if (session.displaySocket) {
      session.displaySocket.emit('go-to-page', { page });
    }
    socket.emit('page-changed', { page });
  });

  // Display → reports total pages & current page
  socket.on('report-pages', ({ totalPages, currentPage }) => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    session.totalPages = totalPages;
    session.currentPage = currentPage;
    if (session.remoteSocket) {
      session.remoteSocket.emit('page-info', { totalPages, currentPage });
    }
  });

  // Remote → laser pointer move
  socket.on('laser-move', ({ x, y }) => {
    const session = sessions[socket.sessionId];
    if (!session || socket.role !== 'remote') return;
    if (session.displaySocket) {
      session.displaySocket.emit('laser-move', { x, y });
    }
  });

  // Remote → laser off
  socket.on('laser-off', () => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    if (session.displaySocket) {
      session.displaySocket.emit('laser-off');
    }
  });

  // Remote → save notes for a page
  socket.on('save-note', ({ page, text }) => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    session.notes[page] = text;
    socket.emit('note-saved', { page });
  });

  // Remote → get note for a page
  socket.on('get-note', ({ page }) => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    socket.emit('note-data', { page, text: session.notes[page] || '' });
  });

  // Remote → toggle dark mode on display
  socket.on('toggle-dark', () => {
    const session = sessions[socket.sessionId];
    if (!session) return;
    session.darkMode = !session.darkMode;
    if (session.displaySocket) {
      session.displaySocket.emit('set-dark', { dark: session.darkMode });
    }
    socket.emit('dark-updated', { dark: session.darkMode });
  });

  // Disconnect
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
