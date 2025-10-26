# Obsidian Sample Plugin

## Overview
This is a sample plugin for Obsidian (https://obsidian.md), a powerful knowledge base application. The plugin demonstrates basic functionality of the Obsidian API and serves as a template for plugin development.

**Project Type:** Obsidian Plugin Development (TypeScript)
**Build System:** esbuild
**Package Manager:** npm
**Current State:** Development environment configured and ready for plugin development

## Recent Changes
- **2025-10-26**: Initial Replit environment setup
  - Installed Node.js 20 and all dependencies
  - Configured build workflow for automatic compilation
  - Verified TypeScript compilation works correctly

## Project Architecture

### Plugin Features
This sample plugin demonstrates:
- Ribbon icon with click notifications
- Status bar text display
- Command palette commands (simple and complex)
- Editor commands for text manipulation
- Plugin settings tab
- DOM event handling
- Interval registration

### File Structure
- `main.ts` - Main plugin source code (TypeScript)
- `main.js` - Compiled plugin (generated, not in git)
- `manifest.json` - Plugin metadata and configuration
- `styles.css` - Plugin styles
- `esbuild.config.mjs` - Build configuration
- `package.json` - Node.js dependencies and scripts
- `tsconfig.json` - TypeScript compiler configuration

### Build Process
- **Development:** `npm run dev` - Watches for changes and auto-compiles
- **Production:** `npm run build` - Type-checks and builds minified version
- **Output:** Compiles `main.ts` → `main.js` using esbuild

## Development Workflow

### Working on the Plugin
1. The "Build Plugin" workflow automatically runs `npm run dev`
2. This watches for changes in `main.ts` and auto-compiles to `main.js`
3. Edit `main.ts` to modify the plugin
4. The compiled output appears in `main.js`

### Testing the Plugin
To test this plugin in Obsidian:
1. Download the compiled files: `main.js`, `manifest.json`, `styles.css`
2. Copy them to your Obsidian vault: `VaultFolder/.obsidian/plugins/sample-plugin/`
3. Reload Obsidian and enable the plugin in Settings → Community Plugins

### Making Changes
- Modify `main.ts` to change plugin behavior
- Update `manifest.json` to change plugin metadata
- Edit `styles.css` to modify plugin styles
- The build process automatically recompiles on save

## Plugin API
- Uses the Obsidian API (imported from 'obsidian' package)
- API documentation: https://github.com/obsidianmd/obsidian-api
- Type definitions included via `obsidian` npm package

## Notes
- This is a **plugin development environment**, not a standalone web application
- The plugin must be loaded into Obsidian to see it in action
- Built files (`main.js`) are automatically generated and excluded from git
