import { Browser, Page, BrowserContext, chromium, firefox, webkit, ElementHandle } from 'playwright';
import { EmulatedSession, Credentials, startBackendAPIContext, AppBackendConstructor, Contexts, EasyFixedFields, Row } from './serial-api';
export * from './serial-api';
import { AppBackend } from 'backend-plus';
import * as discrepances from 'discrepances';
import { DefinedType, Description } from 'guarantee-type';
import { PartialOnUndefinedDeep } from 'type-fest';
import * as json4all from 'json4all';
import { sameValue } from 'best-globals';

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

export async function withTimeout<T>(promise: Promise<T> | (()=>Promise<T>), ms: number, message?:string):Promise<T>{
    return Promise.race([
        promise instanceof Function ? promise() : promise,
        new Promise<T>((_,reject) => { setTimeout(() => reject(new Error(message ?? 'timeout in withTimeout')), ms) })
    ]);
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
    private _page: Page | null = null;
    private get page(){
        if (this._page == null) throw new Error("openGrid with no open page");
        return this._page;
    }
    private set page(value){
        this._page = value;
    }
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
            this._page = null;
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

    booleanRepresentation = {no: false, yes: true, si: true, sí: true, Sí:true, Si: true} as Record<string, boolean>;
    // valueFromVisualRepresentation(representation:string|null, type:{string: Opts}):string
    valueFromVisualRepresentation(representation:string|null, type:Description):any{
        if (representation == null) {
            if ('nullable' in type || 'optional' in type) return null;
            throw new Error(`valueFromVisualRepresentation error NUUL IS not a ${JSON.stringify(type)}`)
        }
        if ('string' in type) return representation;
        if ('boolean' in type) return this.booleanRepresentation[representation];
        throw new Error(`valueFromVisualRepresentation error ${representation} not a ${JSON.stringify(type)}`)
    }

    async openGrid(table: string, filter:Record<string, any>){
        console.log('================>', !!this.page)
        if (this.page == null) throw new Error("openGrid with no open page")
        const url = new URL(`./menu#table=${table}${filter ? `&ff=${json4all.toUrl(filter)}` : ``}`, this.baseUrl).toString();
        console.log('================> going to', url)
        await this.page.goto(url);
        console.log('================> there')
        var tableElement = await this.page.waitForSelector('table.my-grid');
        return tableElement;
    }

    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'):Promise<DefinedType<T>>
    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<Partial<DefinedType<NoInfer<T>>>>, status:'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>
    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'|'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>{
        var tableElement = await this.openGrid(target.table, {})
        var insButton = await tableElement.waitForSelector('button[bp-action=INS]');
        console.log('================> button', !!insButton, (status == 'new'), rowToSave)
        if (status == 'new') {
            insButton.click();
            var pkSelector = `:not([pk-values])`
            console.log('================> clicked', !!insButton)
            console.log(rowToSave, status, primaryKeyValues)
            var tableRow = await tableElement.waitForSelector('> tbody > tr:not([pk-values])', {state:'visible'});
            console.log('================> inserting column pk =', await tableRow.getAttribute('pk-values'))
            await Promise.all([tableRow].map(handler => this.explain(handler)));
        } else {
            var JsonPk = this.getJsonPkValues(target.table, rowToSave, primaryKeyValues);
            var pkSelector = `[pk-values=${escapeCss(JsonPk)}]`
            console.log('================> search', JsonPk)
            console.log('================> searching', `> tbody > tr${pkSelector}`)
            var tableRow = await tableElement.waitForSelector(`> tbody > tr${pkSelector}`);
            console.log('================> updating column pk =', await tableRow.getAttribute('pk-values'))
        }
        var touchedElements = [] as {name:string, element:(typeof tableRow)}[];
        for(var name in rowToSave){
            var prevInputElement = touchedElements[touchedElements.length - 1]?.element;
            var elements = (await tableRow.$$(`>[my-colname=${name}]`));
            console.log('================> selectores', elements.length);
            await Promise.all(elements.map(handler => this.explain(handler)));
            console.log('================> explained!')
            try{
                var element = (await tableRow.waitForSelector(`> [my-colname=${name}]`, {timeout: 1000}));
            }catch(err){
                try {
                    var element = (await tableElement.waitForSelector(`> tbody > tr${pkSelector} > [my-colname=${name}]`, {timeout: 1000}));
                }catch(err){
                    console.log('===========> ERROR ins!', err)
                    throw err;
                }
            }
            console.log('================> have selector', !!tableRow)
            console.log('================> ufiss pk =', await tableRow.getAttribute('pk-values'), ' content =',await element.textContent())
            await element.waitForElementState('visible');
            console.log('================> check pk =', await tableRow.getAttribute('pk-values'), ' content =',await element.textContent())
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
        await Promise.all(touchedElements.map(({name}) => tableElement.waitForSelector(`> tr${pkSelector} > [my-colname=${name}][io-status=temporal-ok],[my-colname=${name}][io-status=ok],[my-colname=${name}]:not([io-status])`)))
        console.log('-------> saved');
        return this.getFieldData(target, touchedElements)
    }

    private async getFieldData<T extends Description>(target: {table: string, description:T}, pairsNameElement:{name:string, element:ElementHandle<HTMLLIElement>}[]){
        if (!('object' in target.description)) throw new Error('description must be {object:{...}}');
        var description: Record<string, Description> = target.description.object;
        var touched = await Promise.all(
                pairsNameElement.map(
                    async ({name, element}) => [name, this.valueFromVisualRepresentation(await element.textContent(), description[name]!)]
                )
            )
        console.log('================> acá', touched)
        var result = Object.fromEntries(
            touched
        );
        console.log('================> ufs', result)
        return result;
        // return guarantee(target.description, result);
    }

    private async getAllVisibleRowsFromGrid<T extends Description>(target: {table: string, description:T}, tableElement: ElementHandle<HTMLLIElement>, columnNames:string[]):Promise<DefinedType<T>[]>{
        console.log('~~~~~~~~~~~~>', target.table);
        var buttonToGetAllRows = await tableElement.waitForSelector('[all-rows-displayed]', {state: 'attached'});
        console.log('~~~~~~~~~~~~>', !!buttonToGetAllRows);
        if (await buttonToGetAllRows.getAttribute('all-rows-displayed') == "no") {
            console.log('------------> get all rows')
            await buttonToGetAllRows.click()
        }
        await tableElement.waitForSelector('[all-rows-displayed=yes]', {state: 'attached'});
        console.log('~~~~~~~~~~~~>', 'están todos');
        var trows = await tableElement.$$('tbody tr');
        console.log('~~~~~~~~~~~~>', trows.length);
        var result = await Promise.all(trows.map(async row => this.getFieldData(target, await this.tdForNames(row, columnNames))));
        console.log('~~~~~~~~~~~~>', 'ufs');
        return result;
    }

    private async tdForNames(tableElement: ElementHandle<HTMLLIElement>, columnNames: string[]){
        return Promise.all(columnNames.map(async name => ({name, element: (await tableElement.waitForSelector(`[my-colname=${name}]`))!})));
    }

    override async tableDataTest<T extends Description>(target: {table: string, description:T} | string, rows: Row[], compare: 'all', opts?: { fixedFields?: EasyFixedFields; }): Promise<void> {
        if (typeof target == "string") throw new Error("must use {table, description} in tableDataTest for Navigators")
        console.log('############>', target.table);
        var tableElement = await this.openGrid(target.table, opts?.fixedFields ?? {});
        console.log('############>', !!tableElement);
        if (opts?.fixedFields && !(opts?.fixedFields instanceof Array) && opts?.fixedFields instanceof Object) {
            var ff = opts?.fixedFields;
            rows = rows.map(row => {
                for (const name in opts?.fixedFields) {
                    if (sameValue(row[name], ff[name])) {
                        delete row[name];
                    } else {
                        throw new Error(`Error in fixedFields in tableDataTest doesn't match the rows in ${name} field`)
                    };
                }
                return row;
            });
        }
        var response = await this.getAllVisibleRowsFromGrid(target, tableElement, rows.length ? Object.keys(rows[0]!) : []);
        if (opts?.fixedFields && !(opts?.fixedFields instanceof Array) && opts?.fixedFields instanceof Object) {
            for (const row of response) {
                for (const name in opts?.fixedFields) {
                    if (row[name] == null) row[name] = opts?.fixedFields[name];
                }
            }
        }
        console.log('############>', response);
        this.compareRows(response, rows, compare);
        console.log('############>', 'ok!');
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

    async explain(handler:ElementHandle<HTMLLIElement>){
        console.log(await handler.evaluate((el) => {
            var result = [] as string[];
            var calculateDatails = (el:any) => {
                if (el.parentElement != null && el.parentElement != el && result.length<20) calculateDatails(el.parentElement);
                var attributes = el.tagName + (el.id ? '#' +el.id : '') + el.className.split(/\s+/).filter((c:any) => c).map((c:string) => '.' + c).join('');
                for (const attr of el.attributes as {name:string, value:string}[]) {
                    attributes += '['+attr.name+'='+attr.value+']';
                }
                result.push(attributes);
            }
            calculateDatails(el);
            return result;
        }));
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