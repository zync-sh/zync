pub fn tool_schemas_claude() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "run_command",
            "description": "Execute a shell command on the server. Use for reading config, checking service status, running diagnostics, managing files, etc.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The shell command to execute" },
                    "reason":  { "type": "string", "description": "One-line explanation of why this command is needed" }
                },
                "required": ["command", "reason"]
            }
        },
        {
            "name": "read_file",
            "description": "Read the full contents of a file on the server.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "write_file",
            "description": "Write (or overwrite) a file on the server. A diff is shown to the user before the write completes.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path":    { "type": "string", "description": "Absolute path to the file" },
                    "content": { "type": "string", "description": "Complete new content for the file" },
                    "reason":  { "type": "string", "description": "Brief description of what this change does" }
                },
                "required": ["path", "content", "reason"]
            }
        },
        {
            "name": "list_files",
            "description": "List the files and directories at a given path on the server.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path to list" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "ask_user",
            "description": "Pause and ask the user a question or request explicit confirmation before proceeding. Always use this before destructive or irreversible operations.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "The question or confirmation request to show the user" }
                },
                "required": ["question"]
            }
        }
    ])
}

pub fn tool_schemas_openai() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Execute a shell command on the server.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "The shell command to execute" },
                        "reason":  { "type": "string", "description": "Why this command is needed" }
                    },
                    "required": ["command", "reason"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the full contents of a file on the server.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path to the file" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write or overwrite a file on the server.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path":    { "type": "string", "description": "Absolute path to the file" },
                        "content": { "type": "string", "description": "Complete new content for the file" },
                        "reason":  { "type": "string", "description": "What this change does" }
                    },
                    "required": ["path", "content", "reason"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files and directories at a given path.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path to list" }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "ask_user",
                "description": "Ask the user a question or request confirmation before proceeding.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "The question to show the user" }
                    },
                    "required": ["question"]
                }
            }
        }
    ])
}

pub fn tool_schemas_gemini() -> serde_json::Value {
    serde_json::json!([{
        "function_declarations": [
            {
                "name": "run_command",
                "description": "Execute a shell command on the server.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "command": { "type": "STRING", "description": "The shell command to execute" },
                        "reason":  { "type": "STRING", "description": "Why this command is needed" }
                    },
                    "required": ["command", "reason"]
                }
            },
            {
                "name": "read_file",
                "description": "Read the full contents of a file on the server.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Absolute path to the file" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "write_file",
                "description": "Write or overwrite a file on the server.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path":    { "type": "STRING", "description": "Absolute path to the file" },
                        "content": { "type": "STRING", "description": "Complete new content for the file" },
                        "reason":  { "type": "STRING", "description": "What this change does" }
                    },
                    "required": ["path", "content", "reason"]
                }
            },
            {
                "name": "list_files",
                "description": "List files and directories at a given path.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "path": { "type": "STRING", "description": "Directory path to list" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "ask_user",
                "description": "Ask the user a question or request confirmation before proceeding.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "question": { "type": "STRING", "description": "The question to show the user" }
                    },
                    "required": ["question"]
                }
            }
        ]
    }])
}

pub fn planning_tool_schemas_claude() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "run_command",
            "description": "Run a READ-ONLY command to investigate the current state. Do not mutate anything.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The read-only shell command" },
                    "reason":  { "type": "string", "description": "What you are trying to find out" }
                },
                "required": ["command", "reason"]
            }
        },
        {
            "name": "read_file",
            "description": "Read a file to understand the current configuration.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "list_files",
            "description": "List directory contents.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path to list" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "propose_plan",
            "description": "Submit a structured execution plan for user approval. Call this once after investigation. Do not make any changes before the user approves.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "description": "One sentence describing what the plan accomplishes" },
                    "steps": {
                        "type": "array",
                        "description": "Ordered list of steps to execute after approval.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id":               { "type": "string",  "description": "Short slug, e.g. step-1" },
                                "title":            { "type": "string",  "description": "Human-readable step name" },
                                "reason":           { "type": "string",  "description": "Why this step is needed" },
                                "command":          { "type": "string",  "description": "Exact command to run, if applicable" },
                                "expectedImpact":   { "type": "string",  "description": "What will change or be confirmed" },
                                "risk":             { "type": "string",  "enum": ["low", "medium", "high"] },
                                "requiresApproval": { "type": "boolean", "description": "True for destructive or irreversible steps" }
                            },
                            "required": ["id", "title", "reason", "risk", "requiresApproval"]
                        }
                    }
                },
                "required": ["summary", "steps"]
            }
        }
    ])
}

pub fn planning_tool_schemas_openai() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a READ-ONLY command to investigate the current state.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "reason":  { "type": "string" }
                    },
                    "required": ["command", "reason"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file to understand the current configuration.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List directory contents.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "propose_plan",
                "description": "Submit a structured execution plan for user approval before any changes are made.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": { "type": "string" },
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id":               { "type": "string" },
                                    "title":            { "type": "string" },
                                    "reason":           { "type": "string" },
                                    "command":          { "type": "string" },
                                    "expectedImpact":   { "type": "string" },
                                    "risk":             { "type": "string", "enum": ["low", "medium", "high"] },
                                    "requiresApproval": { "type": "boolean" }
                                },
                                "required": ["id", "title", "reason", "risk", "requiresApproval"]
                            }
                        }
                    },
                    "required": ["summary", "steps"]
                }
            }
        }
    ])
}

pub fn planning_tool_schemas_gemini() -> serde_json::Value {
    serde_json::json!([{
        "function_declarations": [
            {
                "name": "run_command",
                "description": "Run a READ-ONLY command to investigate the current state.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "command": { "type": "STRING" },
                        "reason":  { "type": "STRING" }
                    },
                    "required": ["command", "reason"]
                }
            },
            {
                "name": "read_file",
                "description": "Read a file to understand the current configuration.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": { "path": { "type": "STRING" } },
                    "required": ["path"]
                }
            },
            {
                "name": "list_files",
                "description": "List directory contents.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": { "path": { "type": "STRING" } },
                    "required": ["path"]
                }
            },
            {
                "name": "propose_plan",
                "description": "Submit a structured execution plan for user approval before any changes are made.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "summary": { "type": "STRING" },
                        "steps": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "properties": {
                                    "id":               { "type": "STRING" },
                                    "title":            { "type": "STRING" },
                                    "reason":           { "type": "STRING" },
                                    "command":          { "type": "STRING" },
                                    "expectedImpact":   { "type": "STRING" },
                                    "risk":             { "type": "STRING", "enum": ["low", "medium", "high"] },
                                    "requiresApproval": { "type": "BOOLEAN" }
                                },
                                "required": ["id", "title", "reason", "risk", "requiresApproval"]
                            }
                        }
                    },
                    "required": ["summary", "steps"]
                }
            }
        ]
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_schema_dispatches_for_openai_compatible_shape() {
        let schema = tool_schemas_openai();
        assert!(schema.as_array().is_some());
        assert_eq!(schema.as_array().unwrap()[0]["type"], "function");
    }

    #[test]
    fn planning_schema_contains_propose_plan() {
        let schema = planning_tool_schemas_claude();
        let arr = schema.as_array().unwrap();
        assert!(arr.iter().any(|item| item["name"] == "propose_plan"));
    }

    #[test]
    fn gemini_schema_uses_function_declarations() {
        let schema = tool_schemas_gemini();
        assert!(schema.as_array().unwrap()[0].get("function_declarations").is_some());
    }
}
