const express = require('express');
const http = require('http');
const session = require('express-session');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const sessionMiddleware = session({
  secret: 'owndc-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server);
io.engine.use(sessionMiddleware);
app.set('io', io);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/users', require('./routes/users'));

// Socket.IO
require('./socket')(io);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
      const address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  console.log(`OwnDC server running on:`);
  console.log(`- Local:   http://localhost:${PORT}`);
  addresses.forEach(addr => console.log(`- Network: http://${addr}:${PORT}`));
});
