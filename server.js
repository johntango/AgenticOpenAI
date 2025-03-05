
/**
 * server.js
 *
 * Minimal Express server using the new OpenAI v2 Node library and 
 * a functional "Conductor" pattern (no classes).
 *
 * Run with: node server.js
 * Ensure you have installed:
 *   npm install express openai node-fetch
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OpenAI } from "openai";
import { get } from "http";

// For ESM __dirname trick:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env if needed
dotenv.config();

// Create OpenAI client (v2)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from "public"
app.use(express.static('public'));

/**
 * In-memory store of Agents.
 * Each agent is an object:
 *   {
 *     id: number,   // unique
 *     name: string,
 *     model: string,
 *     instructions: string,
 *     tools: [      // array of function-tool definitions (v2 style)
 *       {
 *         "type": "function",
 *         "function": {
 *           "name": string,
 *           "description": string,
 *           "parameters": {...}
 *         }
 *       }, ...
 *     ]
 *   }
 */
let agents = [];

/**
 * Example "functions" folder loader.
 * You might have:
 *   ./functions/exampleTool.js
 *   ./functions/anotherTool.js
 * each exporting something like:
 *   export const details = { ... };
 *   export async function execute(arg1, arg2) { ... }
 */


/**
 * createAgent() - functional factory
 * Tools array can be empty or can be assigned later.
 */
function createAgent({ name, model, instructions }) {
  return {
    id: Date.now(),
    name,
    model,
    instructions,
    tools: [], // will hold v2 style function definitions
  };
}

/**
 * getCompletionFromAgent(agent, messages)
 * - calls openAI.chat.completions.create with:
 *     model, messages, tools: agent.tools, tool_choice: "auto"
 * - if model calls a function, we load/execute it, returning
 *   a specialized message object with the tool’s result.
 */

async function getCompletionFromAgent(agent, messages) {
  // Prepend system instructions
  const systemMsg = {
    role: 'system',
    content: agent.instructions || 'You are a helpful agent.',
  };
  const chatMessages = [systemMsg, ...messages];

  // Convert agent.tools to the array of function schemas:
  // For example, if agent.tools are objects with `.details`,
  // you do something like:
  const schema = Object.values(agent.tools).map((toolObj) => toolObj.details);

  try {
    // Call the Chat Completions API
    const response = await openai.chat.completions.create({
      model: agent.model,
      messages: chatMessages,
      tools: schema,      // v2 style
      tool_choice: "auto" // let the model decide if/when to call
    });

    const message = response.choices[0].message;
    if (!message) {
      return {
        role: 'assistant',
        content: '(No content returned.)'
      };
    }

    // 1) If the model calls a *single* function
    if (message.tool_calls[0]) {
      const fnName = message.tool_calls[0].function.name;
      const rawArgs = message.tool_calls[0].function.arguments || "{}";

      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (err) {
        console.warn('Error parsing function call arguments:', err);
      }

      // Load all server-side "execute" implementations from /functions
      const allFunctions = await getFunctions();

      if (allFunctions[fnName]) {
        // Execute the matching function
        const result = await allFunctions[fnName].execute(...Object.values(parsedArgs));

        // Return a "function call" style object, so we can see
        // what function was called and the result
        return {
          role: 'assistant',
          content: '',
          function_call: {
            name: fnName,
            arguments: JSON.stringify(parsedArgs),
          },
          function_result: result,
        };
      } else {
        // The model tried to call a function we don’t have
        return {
          role: 'assistant',
          content: `Function not found: ${fnName}`
        };
      }
    }

    // 2) If there's no function call, return the normal text
    return {
      role: 'assistant',
      content: message.content || '',
    };
  } catch (err) {
    console.error('Error calling OpenAI:', err);
    return {
      role: 'system',
      content: 'Error calling OpenAI API.',
    };
  }
}

/**
 * runMultiAgentConductor({
 *   agentIds: number[],
 *   messages,
 *   max_turns
 * })
 *
 * A simple round-robin approach among the given agentIds.
 * Example logic:
 *   - On each turn, pick next agent by index
 *   - getCompletionFromAgent
 *   - If it calls a function, we append the function result as well
 *   - Stop after max_turns or no new reason to continue
 */
async function runMultiAgentConductor({ agentIds, messages, max_turns = 6 }) {
  const result = {
    messages: [...messages],
  };

  let turnCount = 0;
  let agentIndex = 0;

  while (turnCount < max_turns) {
    const agentId = agentIds[agentIndex];
    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
      result.messages.push({
        role: 'system',
        content: `Agent with id=${agentId} not found. Stopping.`,
      });
      break;
    }

    // This agent responds
    const agentResponse = await getCompletionFromAgent(agent, result.messages);

    // Add the agent’s response to messages
    result.messages.push({
      role: agentResponse.role,       // 'assistant'
      name: agent.name,
      content: JSON.stringify(agentResponse), // might be empty if it was a function call
    });

    // If the model called a function, also push the "function_result"
    if (agentResponse.function_call) {
      result.messages.push({
        role: 'function',
        name: agentResponse.function_call.name,
        content: JSON.stringify(agentResponse.function_result),
      });
    }

    // Round-robin: move to next agent
    agentIndex = (agentIndex + 1) % agentIds.length;
    turnCount++;
  }

  return result;
}

async function getFunctions() {
   
    const files = fs.readdirSync(path.resolve(process.cwd(), "./functions"));
    const openAIFunctions = {};

    for (const file of files) {
        if (file.endsWith(".js")) {
            const moduleName = file.slice(0, -3);
            const modulePath = `./functions/${moduleName}.js`;
            const { details, execute } = await import(modulePath);

            openAIFunctions[moduleName] = {
                "details": details,
                "execute": execute
            };
        }
    }
    return openAIFunctions;
}
async function runFunction(functionName, parameters){

    // Import all functions
    const functions = await getFunctions();

    if (!functions[functionName]) {
        return res.status(404).json({ error: 'Function not found' });
    }

    try {
        // Call the function
        const result = await functions[functionName].execute(...Object.values(parameters));
        console.log(`result: ${JSON.stringify(result)}`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Function execution failed', details: err.message });
    }
};
/* ------------------------------------------------------------------
 *  ROUTES
 * ------------------------------------------------------------------ */

/**
 * GET /agents
 *  returns the list of agents
 */
app.get('/agents', (req, res) => {
  res.json(agents);
});

/**
 * POST /create-agent
 *  - name, model, instructions
 * Creates and stores a new agent
 */
app.post('/create-agent', (req, res) => {
  const { name, model, instructions } = req.body;
  if (!name || !model) {
    return res.status(400).json({ error: 'name and model are required' });
  }

  const newAgent = createAgent({ name, model, instructions });
  agents.push(newAgent);
  return res.json({success: true, newagent: newAgent});
});

/**
 * POST /add-tool
 *  - agentId, toolDef
 * toolDef is an object like:
 *   {
 *     "type": "function",
 *     "function": {
 *       "name": "someTool",
 *       "description": "...",
 *       "parameters": {
 *         "type": "object",
 *         "properties": { ... },
 *         "required": [ ... ]
 *       }
 *     }
 *   }
 */

app.post('/add-tool', async (req, res) => {
  // Expect request body like: { agentId: 123, toolDef: "exampleTool" }
  const { agentId, toolDef } = req.body;
  if (!agentId || !toolDef) {
    return res.status(400).json({ error: 'agentId and toolDef are required' });
  }

  const agent = agents.find(a => a.id === Number(agentId));
  if (!agent) {
    return res.status(404).json({ error: `Agent with id=${agentId} not found.` });
  }

  // If this agent already has this tool name, reject
  if (agent.tools.includes(toolDef)) {
    return res.status(400).json({ error: 'Tool with this name is already assigned.' });
  }

  // Append the tool schema to agent's tools array
  let functions = await getFunctions();
  agent.tools.push(functions[toolDef]);

  return res.json({ success: true, agent });
})
async function getFunctions() {
   
    const files = fs.readdirSync(path.resolve(process.cwd(), "./tools"));
    const openAIFunctions = {};

    for (const file of files) {
        if (file.endsWith(".js")) {
            const moduleName = file.slice(0, -3);
            const modulePath = `./tools/${moduleName}.js`;
            const { details, execute } = await import(modulePath);

            openAIFunctions[moduleName] = {
                "details": details,
                "execute": execute
            };
        }
    }
    return openAIFunctions;
}

/**
 * POST /start-conversation
 *  - agentIds[] : array of IDs in the order you want them to talk
 *  - userInput : the initial user message
 *  - maxTurns : optional
 */
app.post('/start-conversation', async (req, res) => {
  try {
    const { agentIds, userInput, maxTurns } = req.body;
    if (!agentIds || !Array.isArray(agentIds) || agentIds.length === 0) {
      return res.status(400).json({ error: 'agentIds must be a non-empty array' });
    }

    // Build initial messages
    const messages = [
      { role: 'user', content: userInput || '' },
    ];

    const conversation = await runMultiAgentConductor({
      agentIds: agentIds.map(n => Number(n)), 
      messages,
      max_turns: maxTurns || 6,
    });

    return res.json(conversation);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});
// Route to interact with OpenAI API
app.post('/api/execute-function', async (req, res) => {
    const { functionName, parameters } = req.body;

    // Import all functions
    const functions = await getFunctions();

    if (!functions[functionName]) {
        return res.status(404).json({ error: 'Function not found' });
    }

    try {
        // Call the function
        const result = await functions[functionName].execute(...Object.values(parameters));
        console.log(`result: ${JSON.stringify(result)}`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Function execution failed', details: err.message });
    }
});
// Example to interact with OpenAI API and get function descriptions
app.post('/api/callTools', async (req, res) => {
    const { user_message } = req.body;

    const functions = await getFunctions();
    const availableFunctions = Object.values(functions).map(fn => fn.details);
    console.log(`availableFunctions: ${JSON.stringify(availableFunctions)}`);
    let messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: user_message }
    ];
    try {
        // Make OpenAI API call
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            tools: availableFunctions
        });
       
       // Extract the arguments for get_delivery_date
// Note this code assumes we have already determined that the model generated a function call. See below for a more production ready example that shows how to check if the model generated a function call
        const toolCall = response.choices[0].message.tool_calls[0];

// Extract the arguments for get_delivery_date
// Note this code assumes we have already determined that the model generated a function call. 
        if (toolCall) {
            const functionName = toolCall.function.name;
            const parameters = JSON.parse(toolCall.function.arguments);

            const result = await functions[functionName].execute(...Object.values(parameters));
// note that we need to respond with the function call result to the model quoting the tool_call_id
            const function_call_result_message = {
                role: "tool",
                content: JSON.stringify({
                    result: result
                }),
                tool_call_id: response.choices[0].message.tool_calls[0].id
            };
            // add to the end of the messages array to send the function call result back to the model
            messages.push(response.choices[0].message);
            messages.push(function_call_result_message);
            const completion_payload = {
                model: "gpt-4o",
                messages: messages,
            };
            // Call the OpenAI API's chat completions endpoint to send the tool call result back to the model
            const final_response = await openai.chat.completions.create({
                model: completion_payload.model,
                messages: completion_payload.messages
            });
            // Extract the output from the final response
            let output = final_response.choices[0].message.content 


            res.json({ message:output, state: state });
        } else {
            res.json({ message: 'No function call detected.' });
        }

    } catch (error) {
        res.status(500).json({ error: 'OpenAI API failed', details: error.message });
    }
});

/* ------------------------------------------------------------------
 * Start the server
 * ------------------------------------------------------------------ */
function startServer() {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

startServer();
