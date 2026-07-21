export interface Row {
  id: string;
  text: string;
  source: string;
  vector: number[];
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolCall {
  tool: string;
  params: Record<string, any>;
}

export interface Tool {
  description: string;
  params: string[];
  run: (params: Record<string, any>) => Promise<string>;
}

export interface IterationLog {
  iteration: number;
  llm_input: Message[];
  llm_output: string;
  tool_called: string | null;
  tool_params: Record<string, any> | null;
  tool_result: string | null;
  duration_ms: number;
}
