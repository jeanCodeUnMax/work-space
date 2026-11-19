const { execSync } = require('child_process');

try {
  console.log('=== n8n status ===');
  const status = execSync('cli-anything-n8n status', { encoding: 'utf8', stdio: 'pipe' });
  console.log(status);
  
  console.log('\n=== n8n health ===');
  const health = execSync('cli-anything-n8n health', { encoding: 'utf8', stdio: 'pipe' });
  console.log(health);
} catch (e) {
  console.error('Error:', e.message);
  if (e.stdout) console.log('stdout:', e.stdout.toString());
  if (e.stderr) console.error('stderr:', e.stderr.toString());
}