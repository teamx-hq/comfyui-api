import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "child_process";
import { z } from "zod";

interface ComfyDescription {
  samplers: string[];
  schedulers: string[];
}

const {
  CMD = "init.sh",
  HOST = "::",
  PORT = "3000",
  DIRECT_ADDRESS = "127.0.0.1",
  COMFYUI_PORT_HOST = "8188",
  STARTUP_CHECK_INTERVAL_S = "1",
  STARTUP_CHECK_MAX_TRIES = "10",
  COMFY_HOME = "/opt/ComfyUI",
  OUTPUT_DIR,
  INPUT_DIR,
  MODEL_DIR,
  WARMUP_PROMPT_FILE,
  WORKFLOW_MODELS = "all",
  WORKFLOW_DIR = "/workflows",
  MARKDOWN_SCHEMA_DESCRIPTIONS = "true",
  BASE = "ai-dock",
} = process.env;

fs.mkdirSync(WORKFLOW_DIR, { recursive: true });

const comfyURL = `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}`;
const selfURL = `http://localhost:${PORT}`;
const port = parseInt(PORT, 10);
const startupCheckInterval = parseInt(STARTUP_CHECK_INTERVAL_S, 10) * 1000;
const startupCheckMaxTries = parseInt(STARTUP_CHECK_MAX_TRIES, 10);

// type for {string: string}

const loadEnvCommand: Record<string, string> = {
  "ai-dock": `source /opt/ai-dock/etc/environment.sh \
  && source /opt/ai-dock/bin/venv-set.sh comfyui \
  && source "$COMFYUI_VENV/bin/activate"`,
};

// The parent directory of model_dir
const comfyDir = COMFY_HOME;

let warmupPrompt: any | undefined;
let warmupCkpt: string | undefined;
if (WARMUP_PROMPT_FILE) {
  assert(fs.existsSync(WARMUP_PROMPT_FILE), "Warmup prompt file not found");
  try {
    warmupPrompt = JSON.parse(
      fs.readFileSync(WARMUP_PROMPT_FILE, { encoding: "utf-8" })
    );
    for (const nodeId in warmupPrompt) {
      const node = warmupPrompt[nodeId];
      if (node.class_type === "CheckpointLoaderSimple") {
        warmupCkpt = node.inputs.ckpt_name;
        break;
      }
    }
  } catch (e: any) {
    throw new Error(`Failed to parse warmup prompt: ${e.message}`);
  }
}

function getComfyUIDescription(): ComfyDescription {
  const temptComfyFilePath = path.join(comfyDir, "temp_comfy_description.json");
  const pythonCode = `
import comfy.samplers
import json

comfy_description = {
    "samplers": comfy.samplers.KSampler.SAMPLERS,
    "schedulers": comfy.samplers.KSampler.SCHEDULERS,
}

with open("${temptComfyFilePath}", "w") as f:
    json.dump(comfy_description, f)
`;

  const tempFilePath = path.join(comfyDir, "temp_comfy_description.py");
  let command = `python ${tempFilePath}`;
  if (BASE in loadEnvCommand) {
    command = `${loadEnvCommand[BASE]} \
    && python ${tempFilePath}`;
  }

  try {
    // Write the Python code to a temporary file
    fs.writeFileSync(tempFilePath, pythonCode);

    // Execute the Python script synchronously
    execSync(command, {
      cwd: comfyDir,
      encoding: "utf-8",
      shell: "/bin/bash",  // Changed from /bin/sh to /bin/bash
      env: {
        ...process.env,
        PYTHONPATH: '/opt/ComfyUI',
      },
    });
    const output = fs.readFileSync(temptComfyFilePath, { encoding: "utf-8" });
    return JSON.parse(output.trim()) as ComfyDescription;
  } catch (error: any) {
    throw new Error(`Failed to get ComfyUI description: ${error.message}`);
  } finally {
    // Clean up temporary files
    try {
      fs.unlinkSync(tempFilePath);
      if (fs.existsSync(temptComfyFilePath)) {
        fs.unlinkSync(temptComfyFilePath);
      }
    } catch (unlinkError: any) {
      console.error(`Failed to delete temporary file: ${unlinkError.message}`);
    }
  }
}

// Remove getComfyUIDescription function and replace with static values
const comfyDescription = getComfyUIDescription();

const config = {
  comfyLaunchCmd: CMD,
  wrapperHost: HOST,
  wrapperPort: port,
  selfURL,
  comfyHost: DIRECT_ADDRESS,
  comfyPort: COMFYUI_PORT_HOST,
  comfyURL,
  startupCheckInterval,
  startupCheckMaxTries,
  comfyDir,
  outputDir: OUTPUT_DIR ?? path.join(comfyDir, "output"),
  inputDir: INPUT_DIR ?? path.join(comfyDir, "input"),
  workflowDir: WORKFLOW_DIR,
  warmupPrompt,
  warmupCkpt,
  samplers: z.enum(comfyDescription.samplers as [string, ...string[]]),
  schedulers: z.enum(comfyDescription.schedulers as [string, ...string[]]),
  models: {} as Record<
    string,
    {
      dir: string;
      all: string[];
      enum: z.ZodEnum<[string, ...string[]]>;
    }
  >,
  workflowModels: WORKFLOW_MODELS,
  markdownSchemaDescriptions: MARKDOWN_SCHEMA_DESCRIPTIONS === "true",
};

const modelDir = MODEL_DIR ?? path.join(comfyDir, "models");
const modelSubDirs = fs.readdirSync(modelDir);
for (const modelType of modelSubDirs) {
  const model_path = path.join(modelDir, modelType);
  if (fs.statSync(model_path).isDirectory()) {
    const all = fs
      .readdirSync(model_path)
      .filter((f) => !(f.startsWith("put_") && f.endsWith("_here")));
    config.models[modelType] = {
      dir: model_path,
      all,
      enum: z.enum(all as [string, ...string[]]),
    };
  }
}

export default config;
