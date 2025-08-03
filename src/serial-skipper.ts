import { Browser, Page, BrowserContext, chromium, firefox, webkit } from 'playwright';
import { EmulatedSession, Methods, ResultAs, Credentials, startEngineBackendAPI, Constructor } from './probador-serial';
export * from './probador-serial';
import { AppBackend } from 'backend-plus';
import * as discrepances from 'discrepances';

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

// Singleton browser manager - equivalente a startServer pero para browsers
class BrowserManager {
    private browser: Browser | null = null;

    constructor(private config: BrowserConfig) {}

    async start(): Promise<Browser> {
        if (this.browser) {
            return this.browser; // Ya está iniciado
        }

        const browserTypes = { chromium, firefox, webkit };
        const browserType = browserTypes[this.config.browserType!];
        
        this.browser = await browserType.launch({
            headless: this.config.headless,
            slowMo: this.config.slowMo
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

export async function startEngines<T extends AppBackend>(AppConstructor: Constructor<T>, browserConfig?: BrowserConfig):Promise<{backend:T, browser: Browser}>{
    const backend = await startEngineBackendAPI(AppConstructor);
    const browser = await startBrowser(browserConfig);
    return {...backend, browser};
}

export function engineNavigatorStarter<T extends AppBackend>(browserConfig: BrowserConfig){
    return async (AppConstructor: Constructor<T>): Promise<{backend: T, browser: Browser}> => {
        return startEngines(AppConstructor, browserConfig);
    }
}

// BrowserContext representa una sesión de usuario independiente
export class BrowserEmulatedSession<TApp extends AppBackend> extends EmulatedSession<TApp> {
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private sessionConfig: SessionConfig;
    protected browser: Browser;

    constructor(protected engines:{backend: TApp, browser: Browser}, port: number, sessionConfig: SessionConfig = {}) {
        super(engines.backend, port);
        this.browser = engines.browser;
        this.sessionConfig = {
            viewport: { width: 1280, height: 720 },
            recordVideo: false,
            screenshotsPath: './screenshots/',
            ...sessionConfig
        };
    }

    async initSession(): Promise<void> {
        if (this.context) return; // Ya está inicializada
        
        // Cada sesión tiene su propio BrowserContext (cookies independientes)
        this.context = await this.browser.newContext({
            viewport: this.sessionConfig.viewport,
            userAgent: this.sessionConfig.userAgent,
            recordVideo: this.sessionConfig.recordVideo ? { 
                dir: './test-videos/',
                size: this.sessionConfig.viewport 
            } : undefined
        });

        // Una página por sesión
        this.page = await this.context.newPage();

        // Set up logging
        this.page.on('console', msg => console.log(`[Browser Session] ${msg.text()}`));
        this.page.on('pageerror', err => console.error(`[Browser Session] ${err.message}`));
    }

    async closeSession(): Promise<void> {
        if (this.page) {
            await this.page.close();
            this.page = null;
        }
        if (this.context) {
            await this.context.close();
            this.context = null;
        }
    }

    // Override del método request para poder usar browser
    override async request(_params: {path: string, payload?: any, onlyHeaders?: boolean, method?: Methods, parseResult?: ResultAs}): Promise<any> {
        throw new Error(`Navigator emulator can't request`);
    }

    // Login específico para browser
    override async login(credentials: Credentials, opts: { returnErrorMessage?: boolean } = {}): Promise<string | null> {
        await this.initSession();
        if (!this.page) throw new Error('Browser session not initialized');

        const loginUrl = new URL('/login', this.baseUrl).toString();
        await this.page.goto(loginUrl);

        // Llenar formulario de login
        await this.page.fill('input[name="username"]', credentials.username);
        await this.page.fill('input[name="password"]', credentials.password);
        
        // Submit y esperar navegación
        await Promise.all([
            this.page.waitForNavigation(),
            this.page.click('button[type="submit"], input[type="submit"]')
        ]);

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

        var activeUserSpan = await this.page.waitForSelector('.total-layout #active-user', { timeout: 5000 });
        discrepances.showAndThrow(await activeUserSpan.textContent(), credentials.username);
        return null;
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