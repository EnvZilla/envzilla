const crypto = require('crypto');

async function testWebhook() {
    const samplePayload = {
        action: 'opened',
        pull_request: { number: 123 }
    };
    
    const secret = '4C9B740C59D8E6E33B840B0C55BF8DB1CF79152F4FEB088247665F2008F9CFAB';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(samplePayload));
    const signature = `sha256=${hmac.digest('hex')}`;
    
    console.log('Testing webhook...');
    console.log('Signature:', signature);
    
    try {
        const response = await fetch('http://localhost:3000/webhooks/github', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-GitHub-Event': 'pull_request',
                'X-Hub-Signature-256': signature,
                'User-Agent': 'GitHub-Hookshot/test'
            },
            body: JSON.stringify(samplePayload)
        });
        
        const result = await response.text();
        console.log('Status:', response.status);
        console.log('Response:', result);
        
        if (response.ok) {
            console.log('✅ SUCCESS: Webhook works!');
        } else {
            console.log('❌ FAILED: Webhook error');
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testWebhook();
