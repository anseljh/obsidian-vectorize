import { 
        App, 
        Editor, 
        MarkdownView, 
        Modal, 
        Notice, 
        Plugin, 
        PluginSettingTab, 
        Setting,
        TFile,
        normalizePath
} from 'obsidian';
import { Ollama } from 'ollama';
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';

interface VectorizeSettings {
        ollamaModel: string;
        milvusAddress: string;
        collectionName: string;
}

const DEFAULT_SETTINGS: VectorizeSettings = {
        ollamaModel: 'nomic-embed-text',
        milvusAddress: 'http://localhost:19530',
        collectionName: 'obsidian_notes'
}

interface NoteVector {
        id: string;
        file_path: string;
        content: string;
        vector: number[];
        modified_time: number;
}

interface SimilarNote {
        filePath: string;
        score: number;
        content: string;
}

export default class VectorizePlugin extends Plugin {
        settings: VectorizeSettings;
        ollama: Ollama;
        milvus: MilvusClient;
        private collectionInitialized = false;

        async onload() {
                await this.loadSettings();

                this.addRibbonIcon('brain-circuit', 'Vectorize: Find Similar Notes', async () => {
                        await this.findSimilarToCurrentNote();
                });

                this.addCommand({
                        id: 'find-similar-notes',
                        name: 'Find similar notes to current note',
                        editorCallback: async (editor: Editor, view: MarkdownView) => {
                                await this.findSimilarToCurrentNote();
                        }
                });

                this.addCommand({
                        id: 'query-similar-notes',
                        name: 'Query similar notes',
                        callback: async () => {
                                new QueryModal(this.app, this, async (query: string) => {
                                        await this.querySimilarNotes(query);
                                }).open();
                        }
                });

                this.addCommand({
                        id: 'refresh-modified-vectors',
                        name: 'Refresh vectors for modified notes',
                        callback: async () => {
                                await this.refreshModifiedVectors();
                        }
                });

                this.addCommand({
                        id: 'recompute-all-vectors',
                        name: 'Recompute vectors for all notes',
                        callback: async () => {
                                await this.recomputeAllVectors();
                        }
                });

                this.addSettingTab(new VectorizeSettingTab(this.app, this));

                this.initializeServices();
        }

        initializeServices() {
                this.ollama = new Ollama({ host: 'http://localhost:11434' });
                this.milvus = new MilvusClient({ address: this.settings.milvusAddress });
        }

        async ensureCollection(): Promise<boolean> {
                if (this.collectionInitialized) {
                        return true;
                }

                try {
                        const hasCollection = await this.milvus.hasCollection({
                                collection_name: this.settings.collectionName
                        });

                        if (!hasCollection.value) {
                                new Notice('Creating Milvus collection...');
                                await this.createCollection();
                        }

                        const loadState = await this.milvus.getLoadState({
                                collection_name: this.settings.collectionName
                        });

                        if (loadState.state !== 'LoadStateLoaded') {
                                await this.milvus.loadCollectionSync({
                                        collection_name: this.settings.collectionName
                                });
                        }

                        this.collectionInitialized = true;
                        return true;
                } catch (error) {
                        console.error('Error ensuring collection:', error);
                        new Notice(`Error connecting to Milvus: ${error.message}`);
                        return false;
                }
        }

        async createCollection() {
                try {
                        await this.milvus.createCollection({
                                collection_name: this.settings.collectionName,
                                fields: [
                                        {
                                                name: 'id',
                                                description: 'Unique note identifier',
                                                data_type: DataType.VarChar,
                                                is_primary_key: true,
                                                max_length: 512
                                        },
                                        {
                                                name: 'file_path',
                                                description: 'Note file path',
                                                data_type: DataType.VarChar,
                                                max_length: 1024
                                        },
                                        {
                                                name: 'content_preview',
                                                description: 'Content preview',
                                                data_type: DataType.VarChar,
                                                max_length: 2048
                                        },
                                        {
                                                name: 'modified_time',
                                                description: 'Last modified timestamp',
                                                data_type: DataType.Int64
                                        },
                                        {
                                                name: 'vector',
                                                description: 'Embedding vector',
                                                data_type: DataType.FloatVector,
                                                dim: 768
                                        }
                                ],
                                enable_dynamic_field: true
                        });

                        await this.milvus.createIndex({
                                collection_name: this.settings.collectionName,
                                field_name: 'vector',
                                index_type: 'AUTOINDEX',
                                metric_type: 'COSINE'
                        });

                        new Notice('Milvus collection created successfully');
                } catch (error) {
                        console.error('Error creating collection:', error);
                        throw error;
                }
        }

        async generateEmbedding(text: string): Promise<number[]> {
                try {
                        const response = await this.ollama.embeddings({
                                model: this.settings.ollamaModel,
                                prompt: text
                        });
                        return response.embedding;
                } catch (error) {
                        console.error('Error generating embedding:', error);
                        throw new Error(`Failed to generate embedding: ${error.message}`);
                }
        }

        async findSimilarToCurrentNote() {
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!activeView) {
                        new Notice('No active note found');
                        return;
                }

                const file = activeView.file;
                if (!file) {
                        new Notice('No active file found');
                        return;
                }

                new Notice('Finding similar notes...');

                try {
                        const content = await this.app.vault.read(file);
                        const embedding = await this.generateEmbedding(content);
                        const results = await this.searchSimilar(embedding, 10, file.path);
                        
                        if (results.length === 0) {
                                new Notice('No similar notes found');
                                return;
                        }

                        new SimilarNotesModal(this.app, results).open();
                } catch (error) {
                        console.error('Error finding similar notes:', error);
                        new Notice(`Error: ${error.message}`);
                }
        }

        async querySimilarNotes(query: string) {
                if (!query || query.trim().length === 0) {
                        new Notice('Please enter a query');
                        return;
                }

                new Notice('Searching for similar notes...');

                try {
                        const embedding = await this.generateEmbedding(query);
                        const results = await this.searchSimilar(embedding, 10);
                        
                        if (results.length === 0) {
                                new Notice('No similar notes found');
                                return;
                        }

                        new SimilarNotesModal(this.app, results).open();
                } catch (error) {
                        console.error('Error querying similar notes:', error);
                        new Notice(`Error: ${error.message}`);
                }
        }

        async searchSimilar(embedding: number[], limit: number, excludePath?: string): Promise<SimilarNote[]> {
                if (!await this.ensureCollection()) {
                        return [];
                }

                try {
                        const searchResult = await this.milvus.search({
                                collection_name: this.settings.collectionName,
                                data: [embedding],
                                limit: limit + (excludePath ? 1 : 0),
                                output_fields: ['file_path', 'content_preview']
                        });

                        const results: SimilarNote[] = [];
                        
                        if (searchResult.results && searchResult.results.length > 0) {
                                for (const result of searchResult.results) {
                                        const filePath = result.file_path as string;
                                        
                                        if (excludePath && filePath === excludePath) {
                                                continue;
                                        }

                                        results.push({
                                                filePath: filePath,
                                                score: result.score as number,
                                                content: (result.content_preview as string) || ''
                                        });

                                        if (results.length >= limit) {
                                                break;
                                        }
                                }
                        }

                        return results;
                } catch (error) {
                        console.error('Error searching similar notes:', error);
                        throw error;
                }
        }

        async refreshModifiedVectors() {
                new Notice('Refreshing vectors for modified notes...');
                
                if (!await this.ensureCollection()) {
                        return;
                }

                try {
                        const markdownFiles = this.app.vault.getMarkdownFiles();
                        let updatedCount = 0;
                        let errorCount = 0;

                        for (const file of markdownFiles) {
                                try {
                                        const needsUpdate = await this.checkIfNeedsUpdate(file);
                                        if (needsUpdate) {
                                                await this.vectorizeNote(file);
                                                updatedCount++;
                                        }
                                } catch (error) {
                                        console.error(`Error processing ${file.path}:`, error);
                                        errorCount++;
                                }
                        }

                        new Notice(`Updated ${updatedCount} notes${errorCount > 0 ? `, ${errorCount} errors` : ''}`);
                } catch (error) {
                        console.error('Error refreshing vectors:', error);
                        new Notice(`Error: ${error.message}`);
                }
        }

        async checkIfNeedsUpdate(file: TFile): Promise<boolean> {
                try {
                        const query = await this.milvus.query({
                                collection_name: this.settings.collectionName,
                                filter: `file_path == "${file.path}"`,
                                output_fields: ['modified_time']
                        });

                        if (!query.data || query.data.length === 0) {
                                return true;
                        }

                        const storedTime = query.data[0].modified_time as number;
                        return file.stat.mtime > storedTime;
                } catch (error) {
                        return true;
                }
        }

        async recomputeAllVectors() {
                const confirmed = await new Promise((resolve) => {
                        new ConfirmModal(
                                this.app,
                                'Recompute All Vectors',
                                'This will recompute embeddings for all notes in your vault. This may take a while. Continue?',
                                resolve
                        ).open();
                });

                if (!confirmed) {
                        return;
                }

                new Notice('Recomputing all vectors...');
                
                if (!await this.ensureCollection()) {
                        return;
                }

                try {
                        const markdownFiles = this.app.vault.getMarkdownFiles();
                        let processedCount = 0;
                        let errorCount = 0;
                        const total = markdownFiles.length;

                        for (const file of markdownFiles) {
                                try {
                                        await this.vectorizeNote(file);
                                        processedCount++;
                                        
                                        if (processedCount % 10 === 0) {
                                                new Notice(`Processed ${processedCount}/${total} notes...`);
                                        }
                                } catch (error) {
                                        console.error(`Error processing ${file.path}:`, error);
                                        errorCount++;
                                }
                        }

                        new Notice(`Completed! Processed ${processedCount} notes${errorCount > 0 ? `, ${errorCount} errors` : ''}`);
                } catch (error) {
                        console.error('Error recomputing vectors:', error);
                        new Notice(`Error: ${error.message}`);
                }
        }

        async vectorizeNote(file: TFile) {
                const content = await this.app.vault.read(file);
                const embedding = await this.generateEmbedding(content);
                
                const contentPreview = content.substring(0, 500).replace(/\n/g, ' ');
                const noteId = file.path;

                await this.milvus.delete({
                        collection_name: this.settings.collectionName,
                        filter: `file_path == "${file.path}"`
                });

                await this.milvus.insert({
                        collection_name: this.settings.collectionName,
                        data: [{
                                id: noteId,
                                file_path: file.path,
                                content_preview: contentPreview,
                                modified_time: file.stat.mtime,
                                vector: embedding
                        }]
                });
        }

        onunload() {
        }

        async loadSettings() {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        }

        async saveSettings() {
                await this.saveData(this.settings);
                this.initializeServices();
        }
}

class QueryModal extends Modal {
        plugin: VectorizePlugin;
        onSubmit: (query: string) => void;

        constructor(app: App, plugin: VectorizePlugin, onSubmit: (query: string) => void) {
                super(app);
                this.plugin = plugin;
                this.onSubmit = onSubmit;
        }

        onOpen() {
                const { contentEl } = this;
                
                contentEl.createEl('h2', { text: 'Query Similar Notes' });

                const inputContainer = contentEl.createDiv({ cls: 'vectorize-query-input' });
                const textarea = inputContainer.createEl('textarea', {
                        attr: {
                                placeholder: 'Enter your query...',
                                rows: '4'
                        }
                });
                textarea.style.width = '100%';
                textarea.style.marginBottom = '10px';

                const buttonContainer = contentEl.createDiv({ cls: 'vectorize-button-container' });
                buttonContainer.style.display = 'flex';
                buttonContainer.style.gap = '10px';
                buttonContainer.style.justifyContent = 'flex-end';

                const searchButton = buttonContainer.createEl('button', { text: 'Search' });
                searchButton.addClass('mod-cta');
                searchButton.addEventListener('click', () => {
                        const query = textarea.value;
                        this.close();
                        this.onSubmit(query);
                });

                const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
                cancelButton.addEventListener('click', () => {
                        this.close();
                });

                textarea.focus();
                
                textarea.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && e.ctrlKey) {
                                const query = textarea.value;
                                this.close();
                                this.onSubmit(query);
                        }
                });
        }

        onClose() {
                const { contentEl } = this;
                contentEl.empty();
        }
}

class SimilarNotesModal extends Modal {
        results: SimilarNote[];

        constructor(app: App, results: SimilarNote[]) {
                super(app);
                this.results = results;
        }

        onOpen() {
                const { contentEl } = this;
                
                contentEl.createEl('h2', { text: 'Similar Notes' });

                const resultsList = contentEl.createDiv({ cls: 'vectorize-results-list' });
                resultsList.style.maxHeight = '400px';
                resultsList.style.overflowY = 'auto';

                for (const result of this.results) {
                        const resultItem = resultsList.createDiv({ cls: 'vectorize-result-item' });
                        resultItem.style.padding = '10px';
                        resultItem.style.marginBottom = '10px';
                        resultItem.style.border = '1px solid var(--background-modifier-border)';
                        resultItem.style.borderRadius = '5px';
                        resultItem.style.cursor = 'pointer';

                        const titleEl = resultItem.createEl('div', { 
                                text: result.filePath,
                                cls: 'vectorize-result-title'
                        });
                        titleEl.style.fontWeight = 'bold';
                        titleEl.style.marginBottom = '5px';

                        const scoreEl = resultItem.createEl('div', { 
                                text: `Similarity: ${(result.score * 100).toFixed(1)}%`,
                                cls: 'vectorize-result-score'
                        });
                        scoreEl.style.fontSize = '0.9em';
                        scoreEl.style.color = 'var(--text-muted)';
                        scoreEl.style.marginBottom = '5px';

                        if (result.content) {
                                const contentEl = resultItem.createEl('div', { 
                                        text: result.content,
                                        cls: 'vectorize-result-content'
                                });
                                contentEl.style.fontSize = '0.85em';
                                contentEl.style.color = 'var(--text-muted)';
                        }

                        resultItem.addEventListener('click', async () => {
                                const file = this.app.vault.getAbstractFileByPath(result.filePath);
                                if (file instanceof TFile) {
                                        await this.app.workspace.getLeaf().openFile(file);
                                        this.close();
                                }
                        });
                }

                const closeButton = contentEl.createEl('button', { text: 'Close' });
                closeButton.style.marginTop = '10px';
                closeButton.addEventListener('click', () => {
                        this.close();
                });
        }

        onClose() {
                const { contentEl } = this;
                contentEl.empty();
        }
}

class ConfirmModal extends Modal {
        title: string;
        message: string;
        onConfirm: (result: boolean) => void;

        constructor(app: App, title: string, message: string, onConfirm: (result: boolean) => void) {
                super(app);
                this.title = title;
                this.message = message;
                this.onConfirm = onConfirm;
        }

        onOpen() {
                const { contentEl } = this;
                
                contentEl.createEl('h2', { text: this.title });
                contentEl.createEl('p', { text: this.message });

                const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
                buttonContainer.style.display = 'flex';
                buttonContainer.style.gap = '10px';
                buttonContainer.style.justifyContent = 'flex-end';
                buttonContainer.style.marginTop = '20px';

                const confirmButton = buttonContainer.createEl('button', { text: 'Confirm' });
                confirmButton.addClass('mod-warning');
                confirmButton.addEventListener('click', () => {
                        this.close();
                        this.onConfirm(true);
                });

                const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
                cancelButton.addEventListener('click', () => {
                        this.close();
                        this.onConfirm(false);
                });
        }

        onClose() {
                const { contentEl } = this;
                contentEl.empty();
        }
}

class VectorizeSettingTab extends PluginSettingTab {
        plugin: VectorizePlugin;

        constructor(app: App, plugin: VectorizePlugin) {
                super(app, plugin);
                this.plugin = plugin;
        }

        display(): void {
                const { containerEl } = this;

                containerEl.empty();

                containerEl.createEl('h2', { text: 'Vectorize Settings' });

                new Setting(containerEl)
                        .setName('Ollama Model')
                        .setDesc('The Ollama model to use for generating embeddings (default: nomic-embed-text)')
                        .addText(text => text
                                .setPlaceholder('nomic-embed-text')
                                .setValue(this.plugin.settings.ollamaModel)
                                .onChange(async (value) => {
                                        this.plugin.settings.ollamaModel = value || 'nomic-embed-text';
                                        await this.plugin.saveSettings();
                                }));

                new Setting(containerEl)
                        .setName('Milvus Address')
                        .setDesc('The address of your Milvus server (default: http://localhost:19530)')
                        .addText(text => text
                                .setPlaceholder('http://localhost:19530')
                                .setValue(this.plugin.settings.milvusAddress)
                                .onChange(async (value) => {
                                        this.plugin.settings.milvusAddress = value || 'http://localhost:19530';
                                        await this.plugin.saveSettings();
                                }));

                new Setting(containerEl)
                        .setName('Collection Name')
                        .setDesc('The name of the Milvus collection to use (default: obsidian_notes)')
                        .addText(text => text
                                .setPlaceholder('obsidian_notes')
                                .setValue(this.plugin.settings.collectionName)
                                .onChange(async (value) => {
                                        this.plugin.settings.collectionName = value || 'obsidian_notes';
                                        await this.plugin.saveSettings();
                                }));

                containerEl.createEl('h3', { text: 'About' });
                
                const aboutDiv = containerEl.createDiv();
                aboutDiv.createEl('p', { 
                        text: 'Vectorize generates embeddings from your notes using Ollama and stores them in a Milvus vector database for similarity search.' 
                });
                
                aboutDiv.createEl('p', { 
                        text: 'Make sure you have Ollama and Milvus running locally before using this plugin.' 
                });

                const requirementsDiv = containerEl.createDiv();
                requirementsDiv.style.marginTop = '10px';
                requirementsDiv.createEl('p', { text: 'Requirements:', cls: 'setting-item-heading' });
                
                const list = requirementsDiv.createEl('ul');
                list.createEl('li', { text: 'Ollama running on http://localhost:11434' });
                list.createEl('li', { text: 'Milvus running on configured address' });
                list.createEl('li', { text: `Ollama model "${this.plugin.settings.ollamaModel}" installed` });
        }
}
