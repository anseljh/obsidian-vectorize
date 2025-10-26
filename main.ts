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
        requestUrl
} from 'obsidian';

interface VectorizeSettings {
        ollamaModel: string;
        ollamaUrl: string;
        milvusUrl: string;
        collectionName: string;
}

const DEFAULT_SETTINGS: VectorizeSettings = {
        ollamaModel: 'nomic-embed-text',
        ollamaUrl: 'http://localhost:11434',
        milvusUrl: 'http://localhost:19530',
        collectionName: 'obsidian_notes'
}

interface SimilarNote {
        filePath: string;
        score: number;
        content: string;
}

export default class VectorizePlugin extends Plugin {
        settings: VectorizeSettings;
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
        }

        async ensureCollection(): Promise<boolean> {
                if (this.collectionInitialized) {
                        return true;
                }

                try {
                        const hasCollection = await this.milvusHasCollection();

                        if (!hasCollection) {
                                new Notice('Creating Milvus collection...');
                                await this.milvusCreateCollection();
                        }

                        await this.milvusLoadCollection();
                        this.collectionInitialized = true;
                        return true;
                } catch (error) {
                        console.error('Error ensuring collection:', error);
                        new Notice(`Error connecting to Milvus: ${error.message}`);
                        return false;
                }
        }

        async milvusHasCollection(): Promise<boolean> {
                const response = await requestUrl({
                        url: `${this.settings.milvusUrl}/v2/vectordb/collections/has`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                collectionName: this.settings.collectionName
                        })
                });

                return response.json.data?.has || false;
        }

        async milvusCreateCollection() {
                await requestUrl({
                        url: `${this.settings.milvusUrl}/v2/vectordb/collections/create`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                collectionName: this.settings.collectionName,
                                dimension: 768,
                                metricType: 'COSINE',
                                schema: {
                                        fields: [
                                                {
                                                        fieldName: 'id',
                                                        dataType: 'VarChar',
                                                        isPrimary: true,
                                                        elementTypeParams: { max_length: '512' }
                                                },
                                                {
                                                        fieldName: 'file_path',
                                                        dataType: 'VarChar',
                                                        elementTypeParams: { max_length: '1024' }
                                                },
                                                {
                                                        fieldName: 'content_preview',
                                                        dataType: 'VarChar',
                                                        elementTypeParams: { max_length: '2048' }
                                                },
                                                {
                                                        fieldName: 'modified_time',
                                                        dataType: 'Int64'
                                                },
                                                {
                                                        fieldName: 'vector',
                                                        dataType: 'FloatVector',
                                                        elementTypeParams: { dim: '768' }
                                                }
                                        ]
                                }
                        })
                });

                new Notice('Milvus collection created successfully');
        }

        async milvusLoadCollection() {
                await requestUrl({
                        url: `${this.settings.milvusUrl}/v2/vectordb/collections/load`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                collectionName: this.settings.collectionName
                        })
                });
        }

        async generateEmbedding(text: string): Promise<number[]> {
                try {
                        const response = await requestUrl({
                                url: `${this.settings.ollamaUrl}/api/embed`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                        model: this.settings.ollamaModel,
                                        input: text
                                })
                        });

                        const data = response.json;
                        
                        if (data.embeddings && data.embeddings.length > 0) {
                                return data.embeddings[0];
                        }
                        
                        if (data.embedding) {
                                return data.embedding;
                        }

                        throw new Error('No embedding returned from Ollama');
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
                        const response = await requestUrl({
                                url: `${this.settings.milvusUrl}/v2/vectordb/entities/search`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                        collectionName: this.settings.collectionName,
                                        data: [embedding],
                                        annsField: 'vector',
                                        limit: limit + (excludePath ? 1 : 0),
                                        outputFields: ['file_path', 'content_preview']
                                })
                        });

                        const results: SimilarNote[] = [];
                        const searchResults = response.json.data || [];
                        
                        for (const item of searchResults) {
                                if (!item || item.length === 0) continue;
                                
                                for (const result of item) {
                                        const filePath = result.file_path;
                                        
                                        if (excludePath && filePath === excludePath) {
                                                continue;
                                        }

                                        results.push({
                                                filePath: filePath,
                                                score: result.distance || 0,
                                                content: result.content_preview || ''
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
                        const response = await requestUrl({
                                url: `${this.settings.milvusUrl}/v2/vectordb/entities/query`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                        collectionName: this.settings.collectionName,
                                        filter: `file_path == "${file.path}"`,
                                        outputFields: ['modified_time']
                                })
                        });

                        const data = response.json.data;
                        if (!data || data.length === 0) {
                                return true;
                        }

                        const storedTime = data[0].modified_time;
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

                try {
                        await requestUrl({
                                url: `${this.settings.milvusUrl}/v2/vectordb/entities/delete`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                        collectionName: this.settings.collectionName,
                                        filter: `file_path == "${file.path}"`
                                })
                        });
                } catch (error) {
                }

                await requestUrl({
                        url: `${this.settings.milvusUrl}/v2/vectordb/entities/insert`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                collectionName: this.settings.collectionName,
                                data: [{
                                        id: noteId,
                                        file_path: file.path,
                                        content_preview: contentPreview,
                                        modified_time: file.stat.mtime,
                                        vector: embedding
                                }]
                        })
                });
        }

        onunload() {
        }

        async loadSettings() {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        }

        async saveSettings() {
                await this.saveData(this.settings);
                this.collectionInitialized = false;
        }

        async testOllamaConnection(): Promise<{ success: boolean; message: string; model?: string }> {
                try {
                        const response = await requestUrl({
                                url: `${this.settings.ollamaUrl}/api/tags`,
                                method: 'GET',
                                headers: { 'Content-Type': 'application/json' }
                        });

                        const models = response.json.models || [];
                        const hasModel = models.some((m: any) => m.name === this.settings.ollamaModel);

                        if (hasModel) {
                                return { 
                                        success: true, 
                                        message: `Connected! Model "${this.settings.ollamaModel}" is available.`,
                                        model: this.settings.ollamaModel
                                };
                        } else {
                                return { 
                                        success: false, 
                                        message: `Connected, but model "${this.settings.ollamaModel}" not found. Available models: ${models.map((m: any) => m.name).join(', ')}`
                                };
                        }
                } catch (error) {
                        return { 
                                success: false, 
                                message: `Failed to connect to Ollama: ${error.message}`
                        };
                }
        }

        async testMilvusConnection(): Promise<{ success: boolean; message: string }> {
                try {
                        const response = await requestUrl({
                                url: `${this.settings.milvusUrl}/v2/vectordb/collections/list`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({})
                        });

                        if (response.json.code === 0 || response.json.data) {
                                const collections = response.json.data || [];
                                const hasCollection = collections.includes(this.settings.collectionName);
                                
                                if (hasCollection) {
                                        return { 
                                                success: true, 
                                                message: `Connected! Collection "${this.settings.collectionName}" exists.`
                                        };
                                } else {
                                        return { 
                                                success: true, 
                                                message: `Connected! Collection "${this.settings.collectionName}" will be created on first use.`
                                        };
                                }
                        } else {
                                return { 
                                        success: false, 
                                        message: `Unexpected response from Milvus: ${response.json.message || 'Unknown error'}`
                                };
                        }
                } catch (error) {
                        return { 
                                success: false, 
                                message: `Failed to connect to Milvus: ${error.message}`
                        };
                }
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

                containerEl.createEl('h3', { text: 'Ollama Configuration' });

                new Setting(containerEl)
                        .setName('Ollama URL')
                        .setDesc('The URL of your Ollama server (default: http://localhost:11434)')
                        .addText(text => text
                                .setPlaceholder('http://localhost:11434')
                                .setValue(this.plugin.settings.ollamaUrl)
                                .onChange(async (value) => {
                                        this.plugin.settings.ollamaUrl = value || 'http://localhost:11434';
                                        await this.plugin.saveSettings();
                                }));

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

                const ollamaStatusSetting = new Setting(containerEl)
                        .setName('Ollama Connection Status')
                        .setDesc('Test the connection to your Ollama server');

                const ollamaStatusEl = ollamaStatusSetting.descEl.createDiv({ cls: 'vectorize-status' });
                ollamaStatusEl.style.marginTop = '10px';
                ollamaStatusEl.style.padding = '8px';
                ollamaStatusEl.style.borderRadius = '4px';
                ollamaStatusEl.style.fontSize = '0.9em';
                ollamaStatusEl.setText('Click "Test Connection" to check status');
                ollamaStatusEl.style.backgroundColor = 'var(--background-secondary)';

                ollamaStatusSetting.addButton(button => button
                        .setButtonText('Test Connection')
                        .onClick(async () => {
                                button.setButtonText('Testing...');
                                button.setDisabled(true);
                                
                                const result = await this.plugin.testOllamaConnection();
                                
                                ollamaStatusEl.setText(result.message);
                                if (result.success) {
                                        ollamaStatusEl.style.backgroundColor = 'var(--background-modifier-success)';
                                        ollamaStatusEl.style.color = 'var(--text-on-accent)';
                                } else {
                                        ollamaStatusEl.style.backgroundColor = 'var(--background-modifier-error)';
                                        ollamaStatusEl.style.color = 'var(--text-on-accent)';
                                }
                                
                                button.setButtonText('Test Connection');
                                button.setDisabled(false);
                        }));

                containerEl.createEl('h3', { text: 'Milvus Configuration' });

                new Setting(containerEl)
                        .setName('Milvus URL')
                        .setDesc('The URL of your Milvus server (default: http://localhost:19530)')
                        .addText(text => text
                                .setPlaceholder('http://localhost:19530')
                                .setValue(this.plugin.settings.milvusUrl)
                                .onChange(async (value) => {
                                        this.plugin.settings.milvusUrl = value || 'http://localhost:19530';
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

                const milvusStatusSetting = new Setting(containerEl)
                        .setName('Milvus Connection Status')
                        .setDesc('Test the connection to your Milvus server');

                const milvusStatusEl = milvusStatusSetting.descEl.createDiv({ cls: 'vectorize-status' });
                milvusStatusEl.style.marginTop = '10px';
                milvusStatusEl.style.padding = '8px';
                milvusStatusEl.style.borderRadius = '4px';
                milvusStatusEl.style.fontSize = '0.9em';
                milvusStatusEl.setText('Click "Test Connection" to check status');
                milvusStatusEl.style.backgroundColor = 'var(--background-secondary)';

                milvusStatusSetting.addButton(button => button
                        .setButtonText('Test Connection')
                        .onClick(async () => {
                                button.setButtonText('Testing...');
                                button.setDisabled(true);
                                
                                const result = await this.plugin.testMilvusConnection();
                                
                                milvusStatusEl.setText(result.message);
                                if (result.success) {
                                        milvusStatusEl.style.backgroundColor = 'var(--background-modifier-success)';
                                        milvusStatusEl.style.color = 'var(--text-on-accent)';
                                } else {
                                        milvusStatusEl.style.backgroundColor = 'var(--background-modifier-error)';
                                        milvusStatusEl.style.color = 'var(--text-on-accent)';
                                }
                                
                                button.setButtonText('Test Connection');
                                button.setDisabled(false);
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
                list.createEl('li', { text: `Ollama running on ${this.plugin.settings.ollamaUrl}` });
                list.createEl('li', { text: `Milvus running on ${this.plugin.settings.milvusUrl}` });
                list.createEl('li', { text: `Ollama model "${this.plugin.settings.ollamaModel}" installed` });
        }
}
