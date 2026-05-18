import { currentTimeTool } from './current-time.mjs';
import { webSearchTool } from './web-search.mjs';
import { calculatorTool } from './calculator.mjs';
import { uuidGenTool } from './uuid-gen.mjs';
import { delegateTaskTool } from './delegate-task.mjs';
import { webFetchTool } from './web-fetch.mjs';

export const builtinTools = [
  currentTimeTool,
  webSearchTool,
  calculatorTool,
  uuidGenTool,
  delegateTaskTool,
  webFetchTool,
];
