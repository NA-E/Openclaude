# Tools

This file defines the tool usage guidelines for OpenClaude agents.

## Built-in Tools

### shell_exec
Execute shell commands on the local machine.
- Use for git, npm, system administration, and script execution
- Commands are executed in the workspace directory by default
- Dangerous commands are blocked in sandbox mode
- Set a timeout to prevent hanging commands

### file_read
Read file contents from the local filesystem.
- Works with any text file
- Large files are automatically truncated
- Binary files are not supported

### file_write
Write content to a file.
- Creates parent directories if needed
- Overwrites existing files
- Use for creating scripts, configs, and documents

### file_list
List files and directories.
- Shows file type indicators ([DIR] / [FILE])
- Useful for exploring project structures

### memory_remember
Store information in long-term memory.
- Categories: fact, preference, context, task
- Add relevant tags for better recall
- Set importance (0-1) to prioritize memories

### memory_recall
Search long-term memory.
- Uses keyword matching with relevance scoring
- Returns most relevant memories first
- Boost for recent and frequently accessed memories

### sessions_list
List all active sessions.
- Shows sessions across all channels
- Includes agent assignments and message counts

### sessions_send
Send messages between agents.
- Enables multi-agent coordination
- Target agents by their ID
