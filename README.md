# Vectorize - Obsidian Plugin

An Obsidian plugin that enables semantic search across your notes using vector embeddings. Find similar notes based on meaning, not just keywords.

## Features

- 🧠 **Semantic Search**: Find notes by meaning using AI-powered embeddings
- 🔍 **Multiple Search Modes**: Search from current note or custom queries
- 🚀 **Fast Vector Search**: Uses Milvus for efficient similarity matching
- 🔄 **Smart Updates**: Only reprocesses modified notes
- ⚙️ **Configurable**: Choose your embedding model and database settings

## Commands

- **Find similar notes to current note**: Analyzes the active note and displays similar notes
- **Query similar notes**: Search for notes similar to custom text
- **Refresh vectors for modified notes**: Updates only changed notes
- **Recompute vectors for all notes**: Rebuild the entire vector database

## Prerequisites

Before installing this plugin, you need to have running locally:

1. **Ollama** - AI model runtime
   - Install from: https://ollama.ai
   - Should be running on `http://localhost:11434`
   - Install the embedding model: `ollama pull nomic-embed-text`

2. **Milvus** - Vector database
   - Install from: https://milvus.io/docs/install_standalone-docker.md
   - Should be running on `localhost:19530`

## Installation

### From Release
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder in your vault: `VaultFolder/.obsidian/plugins/vectorize/`
3. Copy the downloaded files to that folder
4. Reload Obsidian
5. Enable "Vectorize" in Settings → Community Plugins

### From Source
1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the plugin
4. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder
5. Reload Obsidian and enable the plugin

## Configuration

Open Settings → Vectorize to configure:

- **Ollama Model**: The embedding model to use (default: `nomic-embed-text`)
- **Milvus Address**: Vector database connection (default: `localhost:19530`)
- **Collection Name**: Database collection name (default: `obsidian_notes`)

## Usage

### First Time Setup
1. Make sure Ollama and Milvus are running
2. Open the command palette (Ctrl/Cmd + P)
3. Run: "Vectorize: Recompute vectors for all notes"
4. Wait for processing to complete

### Finding Similar Notes
1. Open any note
2. Run: "Vectorize: Find similar notes to current note"
3. Click on any result to open that note

### Custom Search
1. Run: "Vectorize: Query similar notes"
2. Enter your search text
3. View results based on semantic similarity

### Keeping Vectors Updated
- Run "Refresh vectors for modified notes" periodically
- Or run "Recompute vectors for all notes" to rebuild everything

## How It Works

1. **Embedding Generation**: Your note content is sent to Ollama, which generates a 768-dimensional vector representing the semantic meaning
2. **Vector Storage**: These embeddings are stored in Milvus along with note metadata
3. **Similarity Search**: When searching, Milvus uses cosine similarity to find the most semantically similar notes
4. **Smart Updates**: Only notes that have been modified are reprocessed

## Development

### Building
```bash
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

### Project Structure
- `main.ts` - Plugin source code
- `manifest.json` - Plugin metadata
- `esbuild.config.mjs` - Build configuration
- `package.json` - Dependencies

## Troubleshooting

### "Error connecting to Milvus"
- Check that Milvus is running: `docker ps` (if using Docker)
- Verify the address in settings matches your Milvus instance

### "Failed to generate embedding"
- Check that Ollama is running: `ollama list`
- Verify the model is installed: `ollama pull nomic-embed-text`
- Check Ollama is accessible at http://localhost:11434

### No results found
- Run "Recompute vectors for all notes" to rebuild the index
- Check that notes were successfully processed

## Privacy & Data

- All processing happens locally on your machine
- No data is sent to external servers
- Embeddings are stored in your local Milvus instance
- You have full control over your data

## License

MIT License - See LICENSE file for details

## Credits

- Built for [Obsidian](https://obsidian.md)
- Uses [Ollama](https://ollama.ai) for embeddings
- Uses [Milvus](https://milvus.io) for vector storage
