/**
 * script.js
 * 
 * Handles the front-end logic:
 *  - Toggling background
 *  - Creating agents
 *  - Adding tools
 *  - Listing agents
 *  - Starting conversation among multiple agents
 */

// Toggle background color
const toggleBackgroundBtn = document.getElementById('toggleBackgroundBtn');
toggleBackgroundBtn.addEventListener('click', () => {
  const body = document.body;
  if (body.classList.contains('bg-light')) {
    body.classList.remove('bg-light');
    body.classList.add('bg-secondary', 'text-white');
  } else {
    body.classList.remove('bg-secondary', 'text-white');
    body.classList.add('bg-light');
  }
});

// Elements
const createAgentBtn = document.getElementById('createAgentBtn');
const agentNameInput = document.getElementById('agentName');
const agentModelInput = document.getElementById('modelInput');
const agentInstructionsInput = document.getElementById('agentInstructions');
const agentsList = document.getElementById('agentsList');
const refreshAgentsBtn = document.getElementById('refreshAgentsBtn');

const toolAgentIdInput = document.getElementById('toolAgentId');
const toolNameInput = document.getElementById('toolName');
const addToolBtn = document.getElementById('addToolBtn');

const agentIdsInput = document.getElementById('agentIds');
const userInputField = document.getElementById('userInput');
const maxTurnsInput = document.getElementById('maxTurns');
const startConversationBtn = document.getElementById('startConversationBtn');

const resultArea = document.getElementById('resultArea');

/**
 * CREATE AGENT
 */
createAgentBtn.addEventListener('click', async () => {
  const name = agentNameInput.value.trim();
    // Read the selected model from the dropdown
  const model = document.getElementById('modelInput').value;
  const instructions = agentInstructionsInput.value.trim();

  if (!name || !model) {
    alert('Agent name and model are required');
    return;
  }

  try {
    let resp = await fetch('/create-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, model, instructions }),
    });
 
    let data = await resp.json();
    console.log(data.newagent);
    alert(`Agent created! ID: ${data.newagent.id}, Name: ${data.newagent.name}`);
    // Clear fields
    agentNameInput.value = '';
    agentInstructionsInput.value = '';
  } catch (err) {
    console.error(err);
    alert('Error: cannot create agent');
  }
});

/**
 * REFRESH AGENTS LIST
 */
refreshAgentsBtn.addEventListener('click', async () => {
  agentsList.innerHTML = 'Loading...';
  try {
    const resp = await fetch('/agents');
    if (!resp.ok) {
      agentsList.innerHTML = 'Error loading agents.';
      return;
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      agentsList.innerHTML = 'Invalid data';
      return;
    }
    agentsList.innerHTML = '';
    data.forEach(agent => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.textContent = `ID=${agent.id}, name=${agent.name}, model=${agent.model}, tools=[${agent.tools.map(t => t).join(', ')}]`;
      agentsList.appendChild(li);
    });
  } catch (err) {
    console.error(err);
    agentsList.innerHTML = 'Error fetching agents.';
  }
});

/**
 * ADD TOOL
 */
addToolBtn.addEventListener('click', async () => {
  const agentId = toolAgentIdInput.value.trim();
  const toolDef = toolNameInput.value.trim();
  if (!agentId || !toolDef) {
    alert('agentId and toolName are required');
    return;
  }
  try {
    const resp = await fetch('/add-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, toolDef }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert(`Error adding tool: ${data.error || 'Unknown error'}`);
      return;
    }
    alert('Tool added successfully!');
    // Clear fields
    toolAgentIdInput.value = '';
    toolNameInput.value = '';
  } catch (err) {
    console.error(err);
    alert('Error adding tool');
  }
});

/**
 * START MULTI-AGENT CONVERSATION
 */
startConversationBtn.addEventListener('click', async () => {
  resultArea.innerHTML = 'Waiting for response...';
  const agentIdsRaw = agentIdsInput.value.trim();
  const userMessage = userInputField.value.trim();
  const maxTurnsVal = maxTurnsInput.value.trim();

  if (!agentIdsRaw) {
    resultArea.innerHTML = 'No agent IDs provided.';
    return;
  }
  const agentIds = agentIdsRaw.split(',').map(id => id.trim());

  // Build request
  const payload = {
    agentIds,
    userInput: userMessage,
    maxTurns: maxTurnsVal ? Number(maxTurnsVal) : 6,
  };

  try {
    const resp = await fetch('/start-conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const data = await resp.json();
    // data => { messages: [ {role, content, name?}, ... ] }

    // Display
    resultArea.innerHTML = '';
    data.messages.forEach((msg, idx) => {
      const p = document.createElement('p');
      if (msg.role === 'assistant') {
        p.textContent = `[Assistant - ${msg.name}]: ${msg.content}`;
      } else if (msg.role === 'user') {
        p.textContent = `[User]: ${msg.content}`;
      } else if (msg.role === 'system') {
        p.textContent = `[System]: ${msg.content}`;
      } else if (msg.role === 'function') {
        p.textContent = `[Function - ${msg.name}]: ${msg.content}`;
      }
      resultArea.appendChild(p);
    });
  } catch (err) {
    console.error(err);
    resultArea.innerHTML = 'Error occurred.';
  }
});
