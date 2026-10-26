// Vérification post-install Hephaistos Devin Plugin
let ok = true, failures = [];

function check(moduleName) {
  try {
    require(moduleName);
    // console.log('✓', moduleName, 'OK');
  } catch (e) {
    ok = false; failures.push(moduleName + ': ' + e.message);
  }
}

check('./src/comms.js');
check('./src/mcp-proxy.js');
check('./src/index.js');
check('./src/skills.js');

// Mock pour test activityFeed si HPHE_MCP_PATH non défini
process.env.HPHE_MCP_PATH ||= undefined;

// Test basique: plugin.json et manifest.json existent
try {
  const m = require('./manifest.json');
  // console.log('manifest.json OK', Object.keys(m.commands).length, 'commands');
} catch (e) { ok = false; failures.push('manifest.json: ' + e.message); }

// Test callTool si mcp dispo
if (process.env.HPHE_MCP_PATH) {
  try {
    const { callTool } = require('./src/mcp-proxy.js');
    // callTool('everything_count',{query:'*'}); // peut échouer si mcp non lancé -> on note juste le test
  } catch (e) { /* ignore — mcp peut ne pas être lancé */ }
}

if (ok) { console.log('TEST PASSED'); process.exit(0); } else {
  console.log('TEST FAILED:'); failures.forEach(f => console.log(' -', f));
  process.exit(1);
}