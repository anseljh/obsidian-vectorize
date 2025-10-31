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
        chromaUrl: string;
        collectionName: string;
}

const DEFAULT_SETTINGS: VectorizeSettings = {
        ollamaModel: 'nomic-embed-text:latest',
        ollamaUrl: 'http://localhost:11434',
        chromaUrl: 'http://localhost:8000',
        collectionName: 'overseer_dev'
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
                        const response = await requestUrl({
                                url: `${this.settings.chromaUrl}/api/v2/collections`,
                                method: 'GET',
                                headers: { 'Content-Type': 'application/json' }
                        });

                        if (response.status !== 200) {
                                throw new Error(`Chroma server returned status ${response.status}`);
                        }

                        const collections = Array.isArray(response.json) ? response.json : response.json.collections;
                        
                        if (!Array.isArray(collections)) {
                                throw new Error(`Unexpected response format from Chroma`);
                        }

                        const collectionExists = collections.some((col: any) => col.name === this.settings.collectionName);

                        if (!collectionExists) {
                                new Notice('Creating Chroma collection...');
                                const createResponse = await requestUrl({
                                        url: `${this.settings.chromaUrl}/api/v2/collections`,
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                                name: this.settings.collectionName,
                                                metadata: {
                                                        'hnsw:space': 'cosine'
                                                }
                                        })
                                });
                                
                                if (createResponse.status !== 200 && createResponse.status !== 201) {
                                        throw new Error(`Failed to create collection: status ${createResponse.status}`);
                                }
                                
                                new Notice('Chroma collection created successfully');
                        }

                        this.collectionInitialized = true;
                        return true;
                } catch (error) {
                        console.error('Error ensuring collection:', error);
                        new Notice(`Error connecting to Chroma: ${error.message}`);
                        return false;
                }
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
                                url: `${this.settings.chromaUrl}/api/v2/collections/${this.settings.collectionName}/query`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                        query_embeddings: [embedding],
                                        n_results: limit + (excludePath ? 1 : 0),
                                        include: ['metadatas', 'documents', 'distances']
                                })
                        });

                        const results: SimilarNote[] = [];
                        const data = response.json;
                        
                        if (!data.ids || !data.ids[0]) {
                                return results;
                        }

                        const ids = data.ids[0];
                        const metadatas = data.metadatas?.[0] || [];
                        const documents = data.documents?.[0] || [];
                        const distances = data.distances?.[0] || [];

                        for (let i = 0; i < ids.length; i++) {
                                const filePath = metadatas[i]?.file_path;
                                
                                if (!filePath || (excludePath && filePath === excludePath)) {
                                        continue;
                                }

                                results.push({
                                        filePath: filePath,
                                        score: 1 - (distances[i] || 0),
                                        content: metadatas[i]?.content_preview || ''
                                });

                                if (results.length >= limit) {
                                        break;
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
                                url: `${this.settings.chromaUrl}/api/v2/collections/${this.settings.collectionName}/get`,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                        ids: [file.path],
                                        include: ['metadatas']
                                })
                        });

                        const data = response.json;
                        if (!data.ids || data.ids.length === 0) {
                                return true;
                        }

                        const metadata = data.metadatas?.[0];
                        if (!metadata || !metadata.modified_time) {
                                return true;
                        }

                        return file.stat.mtime > metadata.modified_time;
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

                await requestUrl({
                        url: `${this.settings.chromaUrl}/api/v2/collections/${this.settings.collectionName}/upsert`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                ids: [file.path],
                                embeddings: [embedding],
                                metadatas: [{
                                        file_path: file.path,
                                        content_preview: contentPreview,
                                        modified_time: file.stat.mtime
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

        async testChromaConnection(): Promise<{ success: boolean; message: string }> {
                try {
                        const response = await requestUrl({
                                url: `${this.settings.chromaUrl}/api/v2/collections`,
                                method: 'GET',
                                headers: { 'Content-Type': 'application/json' }
                        });

                        if (response.status !== 200) {
                                return { 
                                        success: false, 
                                        message: `Chroma server returned status ${response.status}`
                                };
                        }

                        const collections = Array.isArray(response.json) ? response.json : response.json.collections;
                        
                        if (!Array.isArray(collections)) {
                                return { 
                                        success: false, 
                                        message: `Unexpected response format from Chroma: ${JSON.stringify(response.json)}`
                                };
                        }

                        const hasCollection = collections.some((col: any) => col.name === this.settings.collectionName);
                        
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
                } catch (error) {
                        return { 
                                success: false, 
                                message: `Failed to connect to Chroma: ${error.message}`
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

                containerEl.createEl('h3', { text: 'Chroma Configuration' });

                new Setting(containerEl)
                        .setName('Chroma URL')
                        .setDesc('The URL of your Chroma server (default: http://localhost:8000)')
                        .addText(text => text
                                .setPlaceholder('http://localhost:8000')
                                .setValue(this.plugin.settings.chromaUrl)
                                .onChange(async (value) => {
                                        this.plugin.settings.chromaUrl = value || 'http://localhost:8000';
                                        await this.plugin.saveSettings();
                                }));

                new Setting(containerEl)
                        .setName('Collection Name')
                        .setDesc('The name of the Chroma collection to use (default: overseer_dev)')
                        .addText(text => text
                                .setPlaceholder('overseer_dev')
                                .setValue(this.plugin.settings.collectionName)
                                .onChange(async (value) => {
                                        this.plugin.settings.collectionName = value || 'overseer_dev';
                                        await this.plugin.saveSettings();
                                }));

                const chromaStatusSetting = new Setting(containerEl)
                        .setName('Chroma Connection Status')
                        .setDesc('Test the connection to your Chroma server');

                const chromaStatusEl = chromaStatusSetting.descEl.createDiv({ cls: 'vectorize-status' });
                chromaStatusEl.style.marginTop = '10px';
                chromaStatusEl.style.padding = '8px';
                chromaStatusEl.style.borderRadius = '4px';
                chromaStatusEl.style.fontSize = '0.9em';
                chromaStatusEl.setText('Click "Test Connection" to check status');
                chromaStatusEl.style.backgroundColor = 'var(--background-secondary)';

                chromaStatusSetting.addButton(button => button
                        .setButtonText('Test Connection')
                        .onClick(async () => {
                                button.setButtonText('Testing...');
                                button.setDisabled(true);
                                
                                const result = await this.plugin.testChromaConnection();
                                
                                chromaStatusEl.setText(result.message);
                                if (result.success) {
                                        chromaStatusEl.style.backgroundColor = 'var(--background-modifier-success)';
                                        chromaStatusEl.style.color = 'var(--text-on-accent)';
                                } else {
                                        chromaStatusEl.style.backgroundColor = 'var(--background-modifier-error)';
                                        chromaStatusEl.style.color = 'var(--text-on-accent)';
                                }
                                
                                button.setButtonText('Test Connection');
                                button.setDisabled(false);
                        }));

                containerEl.createEl('h3', { text: 'About' });
                
                const aboutDiv = containerEl.createDiv();
                aboutDiv.createEl('p', { 
                        text: 'Vectorize generates embeddings from your notes using Ollama and stores them in a Chroma vector database for similarity search.' 
                });
                
                aboutDiv.createEl('p', { 
                        text: 'Make sure you have Ollama and Chroma running locally before using this plugin.' 
                });

                const requirementsDiv = containerEl.createDiv();
                requirementsDiv.style.marginTop = '10px';
                requirementsDiv.createEl('p', { text: 'Requirements:', cls: 'setting-item-heading' });
                
                const list = requirementsDiv.createEl('ul');
                list.createEl('li', { text: `Ollama running on ${this.plugin.settings.ollamaUrl}` });
                list.createEl('li', { text: `Chroma running on ${this.plugin.settings.chromaUrl}` });
                list.createEl('li', { text: `Ollama model "${this.plugin.settings.ollamaModel}" installed` });
        }
}
