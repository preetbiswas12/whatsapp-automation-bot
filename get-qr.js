const http = require('http');
const fs = require('fs');

const KEY = 'dev-admin-key';
const SESSION = '19f01e85-ea61-4543-ad51-fc6c74089acc';

const req = http.get(`http://localhost:2785/api/sessions/${SESSION}/qr`, {
  headers: { 'X-API-Key': KEY }
}, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    const data = JSON.parse(body);
    const base64 = data.qrCode.replace('data:image/png;base64,', '');
    fs.writeFileSync('qr-code.png', Buffer.from(base64, 'base64'));
    console.log('QR code saved to qr-code.png');
    console.log('Scan it with your WhatsApp app:');
    console.log('  Open WhatsApp → Linked devices → Link a device');
    console.log('  Point your phone camera at the QR code');
  });
});