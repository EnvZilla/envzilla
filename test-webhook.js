// /c:/Users/asd/Documents/Github/envzilla/test-webhook.js
/* eslint-disable no-console */
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// Sample webhook payload for testing
const samplePayload = {
    action: 'opened',
    pull_request: {
        number: 123,
        head: {
            ref: 'feat/new-feature',
            sha: 'abc123def456',
            repo: {
                clone_url: 'https://github.com/user/repo.git',
                full_name: 'user/repo'
            }
        },
        base: {
            ref: 'main',
            repo: {
                clone_url: 'https://github.com/user/repo.git',
                full_name: 'user/repo'
            }
        },
        title: 'Add amazing new feature',
        html_url: 'https://github.com/user/repo/pull/123',
        state: 'open',
        merged: false,
        user: {
            login: 'developer',
            avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
        }
    },
    repository: {
        id: 123456,
        name: 'repo',
        full_name: 'user/repo',
        clone_url: 'https://github.com/user/repo.git',
        ssh_url: 'git@github.com:user/repo.git',
        owner: {
            login: 'user',
            type: 'User'
        }
    },
    sender: {
        login: 'developer',
        avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        type: 'User'
    }
};

// Function to create HMAC signature for testing
function createSignature(payload, secret) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(payload));
    return `sha256=${hmac.digest('hex')}`;
}

// Test function
async function testWebhook() {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '4C9B740C59D8E6E33B840B0C55BF8DB1CF79152F4FEB088247665F2008F9CFAB';
    const signature = createSignature(samplePayload, webhookSecret);
    
    console.log('🧪 Testing webhook with sample payload...');
    console.log('📋 Payload:', JSON.stringify(samplePayload, null, 2));
    console.log('🔐 Signature:', signature);
    
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
        console.log('📤 Response status:', response.status);
        console.log('📥 Response body:', result);
        
        if (response.ok) {
            console.log('✅ Webhook test successful!');
        } else {
            console.log('❌ Webhook test failed!');
        }
    } catch (error) {
        console.error('💥 Error testing webhook:', error.message);
    }
}

// Test health endpoint
async function testHealth() {
    console.log('\n🏥 Testing health endpoint...');
    try {
        const response = await fetch('http://localhost:3000/health');
        const health = await response.json();
        
        console.log('📊 Health status:', health.status);
        console.log('🐳 Docker healthy:', health.checks?.docker);
        console.log('📈 Deployments:', health.checks?.deployments);
        console.log('💾 Memory usage:', health.checks?.system?.memory);
        
        if (health.errors) {
            console.log('⚠️ Health errors:', health.errors);
        }
    } catch (error) {
        console.error('💥 Error testing health:', error.message);
    }
}

// Test deployments endpoint
async function testDeployments() {
    console.log('\n📦 Testing deployments endpoint...');
    try {
        const response = await fetch('http://localhost:3000/deployments');
        const deployments = await response.json();
        
        console.log('📋 Active deployments:', deployments.count);
        console.log('📊 Deployment details:', JSON.stringify(deployments, null, 2));
    } catch (error) {
        console.error('💥 Error testing deployments:', error.message);
    }
}

// Run all tests
async function runTests() {
    console.log('🚀 Starting EnvZilla webhook tests...\n');
    
    await testHealth();
    await testDeployments();
    await testWebhook();
    
    console.log('\n🏁 Tests completed!');
}

// ESM exports
export { testWebhook, testHealth, testDeployments, runTests };

// Run tests if executed directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    runTests().catch(console.error);
}
