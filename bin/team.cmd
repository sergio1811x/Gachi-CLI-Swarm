@echo off
if exist "%~dp0..\dist\src\cli\team.js" (
  node "%~dp0..\dist\src\cli\team.js" %*
) else if exist "%~dp0..\src\cli\team.js" (
  node "%~dp0..\src\cli\team.js" %*
) else (
  node "%~dp0..\dist\src\cli\team.js" %*
)
