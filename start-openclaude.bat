@echo off
title OpenClaude Gateway
echo Starting OpenClaude Gateway...
echo.

cd /d "E:\1.Claude Code\Openclaude"

:: Clear env vars that block nested Claude subprocess execution
set CLAUDECODE=
set ANTHROPIC_API_KEY=

:: Start the gateway
npx tsx src/cli/index.ts start
