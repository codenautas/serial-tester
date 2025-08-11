import { Browser, Page, BrowserContext, chromium, firefox, webkit, ElementHandle } from 'playwright';
import { EmulatedSession, Credentials, startBackendAPIContext, AppBackendConstructor, Contexts } from './serial-api';
export * from './serial-api';
import { AppBackend } from 'backend-plus';
import * as discrepances from 'discrepances';
import { DefinedType, Description, guarantee } from 'guarantee-type';
import { PartialOnUndefinedDeep } from 'type-fest';

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface BrowserConfig {
    browserType?: BrowserType;
    headless?: boolean;
    slowMo?: number; // milliseconds to slow down operations
    recordVideo?: boolean;
    recordScreenshots?: boolean;
}

export interface SessionConfig {
    viewport?: { width: number; height: number };
    userAgent?: string;
    recordVideo?: boolean;
    screenshotsPath?: string;
}

function escapeCss(value: string) {
  return `'`+value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    +`'`;
}

// Singleton browser manager - equivalente a startServer pero para browsers
class BrowserManager {
    private browser: Browser | null = null;

    constructor(private config: BrowserConfig) {}

    async start(): Promise<Browser> {
        if (this.browser) {
            throw new Error('Browser already started. Use stop() to close it first.');
        }

        const browserTypes = { chromium, firefox, webkit };
        const browserApp = browserTypes[this.config.browserType!];
        if (!browserApp) {
            throw new Error(`Unsupported browser type: ${this.config.browserType}`);
        }

        this.browser = await browserApp.launch({
            headless: this.config.headless,
            slowMo: this.config.slowMo,
            args: ['--start-maximized', '--window-position=0,0']
        });

        console.log(`Browser ${this.config.browserType} started`);
        return this.browser;
    }

    async stop(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('Browser stopped');
        }
    }

    getBrowser(): Browser {
        if (!this.browser) {
            throw new Error('Browser not started. Call startBrowser() first.');
        }
        return this.browser;
    }

    isStarted(): boolean {
        return this.browser !== null;
    }
}

// Función global equivalente a startServer
export async function startBrowser(browserConfig?: BrowserConfig): Promise<Browser> {
    var config: BrowserConfig = {
        browserType: 'chromium',
        headless: true,
        slowMo: 0,
        recordVideo: false,
        recordScreenshots: false,
        ...browserConfig
    };
    const manager = new BrowserManager(config);
    return await manager.start();
}

export async function startNavigatorContext<T extends AppBackend>(AppConstructor: AppBackendConstructor<T>, browserConfig?: BrowserConfig):Promise<Contexts<T>>{
    const backend = await startBackendAPIContext(AppConstructor);
    const browser = await startBrowser(browserConfig);
    return {...backend, createSession: () => new BrowserEmulatedSession(backend.backend, browser, backend.backend.config.server.port)};
}

async function areConsecutives<T extends ElementHandle>(page: Page, el1:T, el2:T){
    return page.evaluate(
        ([el1, el2]:any[]) => {
            return el1.nextElementSibling === el2; // Verifica si son hermanos adyacentes
        }, [el1, el2]
    );
}


// BrowserContext representa una sesión de usuario independiente
export class BrowserEmulatedSession<TApp extends AppBackend> extends EmulatedSession<TApp> {
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private sessionConfig: SessionConfig;

    constructor(protected backend: TApp, private browser: Browser, port: number, sessionConfig: SessionConfig = {}) {
        super(backend, port);
        this.sessionConfig = {
            viewport: { width: 1280, height: 720 },
            recordVideo: false,
            screenshotsPath: './screenshots/',
            ...sessionConfig
        };
    }

    async initSession(): Promise<void> {
        if (this.context) return; // Ya está inicializada
        this.context = await this.browser.newContext({
            viewport: this.sessionConfig.viewport,
            userAgent: this.sessionConfig.userAgent,
            recordVideo: this.sessionConfig.recordVideo ? { 
                dir: './test-videos/',
                size: this.sessionConfig.viewport 
            } : undefined
        });
        this.page = await this.context.newPage();
        this.page.on('console', msg => console.log(`[Browser Session] ${msg.text()}`));
        this.page.on('pageerror', err => console.error(`[Browser Session] ${err.message}`));
    }

    override async closeSession(): Promise<void> {
        if (this.page) {
            await this.page.close();
            this.page = null;
        }
        if (this.context) {
            await this.context.close();
            this.context = null;
        }
        await super.closeSession();
    }

    override async login(credentials: Credentials, opts: { returnErrorMessage?: boolean } = {}): Promise<string | null> {
        await this.initSession();
        if (!this.page) throw new Error('Browser session not initialized');
        const loginUrl = new URL('./login', this.baseUrl).toString();
        console.log('going to login page:', this.baseUrl, loginUrl);
        await this.page.goto(loginUrl);
        await this.page.fill('input[name="username"]', credentials.username);
        await this.page.fill('input[name="password"]', credentials.password);
        await this.page.click('button[type="submit"], input[type="submit"]');
        // Verificar login exitoso
        const currentUrl = this.page.url();
        const expectedPath = this.server.config.login.plus.successRedirect;
        if (!currentUrl.includes(expectedPath)) {
            if (opts.returnErrorMessage) {
                const errorElement = await this.page.locator('.error-message').first();
                return await errorElement.textContent() || 'Login failed';
            }
            throw new Error(`Login failed. Current URL: ${currentUrl}`);
        }
        var activeUserSpan = await this.page.waitForSelector('#total-layout #active-user', { timeout: 5000 });
        discrepances.showAndThrow(await activeUserSpan.textContent(), credentials.username);
        return null;
    }
    
    keystrokeStringOfrow<T extends string|boolean|number>(value: T){
        switch (typeof value) {
        case "boolean":
            return value ? "Y" : "N";
        default:
            return value.toLocaleString();
        }
    }

    // valueFromVisualRepresentation(representation:string|null, type:{string: Opts}):string
    valueFromVisualRepresentation(representation:string|null, type:Description):any{
        if (representation == null && ('nullable' in type || 'optional' in type)) return null;
        if ('string' in type) return representation;
        throw new Error(`valueFromVisualRepresentation error ${representation} not a ${JSON.stringify(type)}`)
    }

    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'):Promise<DefinedType<T>>
    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<Partial<DefinedType<NoInfer<T>>>>, status:'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>
    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'|'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>{
        console.log('================>', !!this.page)
        if (this.page == null) throw new Error("saveRecord with no open page")
        const url = new URL(`./menu#table=${target.table}`, this.baseUrl).toString();
        console.log('================> going to', url)
        await this.page.goto(url);
        console.log('================> there')
        var insButton = await this.page.waitForSelector('button[bp-action=INS]');
        console.log('================> button', !!insButton, (status == 'new'), rowToSave)
        if (status == 'new') {
            insButton.click();
            console.log('================> clicked', !!insButton)
            console.log(rowToSave, status, primaryKeyValues)
            var tableRow = await this.page.waitForSelector('table.my-grid tbody tr');
        } else {
            var JsonPk = this.getJsonPkValues(target.table, rowToSave, primaryKeyValues);
            console.log('================> search', JsonPk)
            console.log('================> searching', `table.my-grid tbody tr[pk-values=${escapeCss(JsonPk)}]`)
            var tableRow = await this.page.waitForSelector(`table.my-grid tbody tr[pk-values=${escapeCss(JsonPk)}]`);
            console.log('================> updating column', !!tableRow)
        }
        var touchedElements = [] as {name:string, element:(typeof tableRow)}[];
        for(var name in rowToSave){
            var prevInputElement = touchedElements[touchedElements.length - 1]?.element;
            var element = await tableRow.waitForSelector(`[my-colname=${name}]`);
            console.log('-------> columna', name)
            if (prevInputElement != null && await areConsecutives(this.page, prevInputElement, element)) {
                console.log('*tab*')
                await this.page.keyboard.press('Tab')
            } else {
                await element.focus();
                await this.page.keyboard.press("Shift+End")
                console.log('focus', name, await element.getAttribute('my-colname'));
            }
            await this.page.keyboard.insertText(this.keystrokeStringOfrow(rowToSave[name]));
            touchedElements.push({name, element});
        }
        await this.page.keyboard.press("Tab")
        console.log('-------> saving');
        await Promise.all(touchedElements.map(({name}) => tableRow.waitForSelector(`[my-colname=${name}][io-status=temporary-ok],[my-colname=${name}][io-status=ok],[my-colname=${name}]:not([io-status])`)))
        console.log('-------> saved');
        if (!('object' in target.description)) throw new Error('description must be {object:{...}}');
        var description: Record<string, Description> = target.description.object;
            
        var result = Object.fromEntries(
            await Promise.all(
                touchedElements.map(
                    async ({name, element}) => [name, this.valueFromVisualRepresentation(await element.textContent(), description[name]!)]
                )
            )
        );
        await new Promise(_=>{})
        console.log('================> ufs')
        return guarantee(target.description, result);
    }

    // Utilidades específicas del browser
    async takeScreenshot(name?: string): Promise<string> {
        if (!this.page) throw new Error('Browser session not initialized');
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${this.sessionConfig.screenshotsPath}${name || 'screenshot'}-${timestamp}.png`;
        
        await this.page.screenshot({ path: filename, fullPage: true });
        return filename;
    }

    async waitForElement(selector: string, timeout = 5000): Promise<void> {
        if (!this.page) throw new Error('Browser session not initialized');
        await this.page.waitForSelector(selector, { timeout });
    }

    async getElementText(selector: string): Promise<string> {
        if (!this.page) throw new Error('Browser session not initialized');
        return await this.page.locator(selector).textContent() || '';
    }

    async clickElement(selector: string): Promise<void> {
        if (!this.page) throw new Error('Browser session not initialized');
        await this.page.click(selector);
    }

    async fillForm(selector: string, data: Record<string, any>): Promise<void> {
        if (!this.page) throw new Error('Browser session not initialized');

        for (const [field, value] of Object.entries(data)) {
            const fieldSelector = `${selector} [name="${field}"], ${selector} #${field}`;
            await this.page.fill(fieldSelector, String(value));
        }
    }

    async submitForm(selector: string): Promise<void> {
        if (!this.page) throw new Error('Browser session not initialized');
        
        await Promise.all([
            this.page.waitForNavigation(),
            this.page.click(`${selector} button[type="submit"], ${selector} input[type="submit"]`)
        ]);
    }
}

/*
// Helper para cleanup automático de sesiones
export async function withBrowserSession<TApp extends AppBackend, T>(
    server: TApp,
    port: number,
    sessionConfig: SessionConfig | undefined,
    testFn: (session: BrowserEmulatedSession<TApp>) => Promise<T>
): Promise<T> {
    const session = new BrowserEmulatedSession(server, port, sessionConfig);
    try {
        return await testFn(session);
    } finally {
        await session.closeSession();
    }
}
    */