const http = require('http');

function post(url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(data));
    req.end();
  });
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'GET',
      headers
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const KEY = 'dev-admin-key';
const BASE = 'http://localhost:2785';
const SESSION = '19f01e85-ea61-4543-ad51-fc6c74089acc';

(async () => {
  // 1. Health check
  const health = await get(`${BASE}/api/health`);
  console.log('1. Health:', health.status, health.body);

  // 2. List sessions
  const sessions = await get(`${BASE}/api/sessions`, { 'X-API-Key': KEY });
  console.log('2. Sessions:', sessions.status, sessions.body);

  // 3. Set up webhook
  const webhook = await post(
    `${BASE}/api/sessions/${SESSION}/webhooks`,
    { url: 'http://localhost:3000/webhook', events: ['message.received'], secret: 'my-secret-key-12345' },
    { 'X-API-Key': KEY }
  );
  console.log('3. Webhook:', webhook.status, webhook.body);

  // 4. List webhooks
  const webhooks = await get(`${BASE}/api/sessions/${SESSION}/webhooks`, { 'X-API-Key': KEY });
  console.log('4. Webhooks list:', webhooks.status, webhooks.body);

  // 5. Send a test message (will fail without a connected number, but tests the API)
  const send = await post(
    `${BASE}/api/sessions/${SESSION}/messages/send-text`,
    { chatId: '1234567890@c.us', text: 'Test message' },
    { 'X-API-Key': KEY }
  );
  console.log('5. Send test:', send.status, send.body);

  // 6. Check session status
  const status = await get(`${BASE}/api/sessions/${SESSION}`, { 'X-API-Key': KEY });
  console.log('6. Session status:', status.status, status.body);

  // 7. Test Swagger docs
  const swagger = await get(`${BASE}/api/docs`);
  console.log('7. Swagger:', swagger.status, swagger.body.substring(0, 100));

  console.log('\n=== All tests complete ===');
})();