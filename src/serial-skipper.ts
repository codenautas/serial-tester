import { Browser, Page, BrowserContext, chromium, firefox, webkit, ElementHandle } from 'playwright';
import { AppBackendConstructor, ClientConfig, Contexts, Credentials,
    EmulatedSession, Methods,
    ResponseHeaders, Row, RowDescription, SaveRecordOptions, TableDataTestOptions,
    startContext
} from './serial-api';
export * from './serial-api';
import { AppBackend } from 'backend-plus';
import * as discrepances from 'discrepances';
import { DefinedType, Description } from 'guarantee-type';
import { PartialOnUndefinedDeep } from 'type-fest';
import * as json4all from 'json4all';
import { date, sameValue, RealDate } from 'best-globals';
import { expected, unexpected } from 'cast-error';

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export const TO = {
    beLoaded: 1000,
    loggedIn: 5000,
    noWaitMustBeThere:100,
    beforeRetype: 1000,
    afterRetype: 5000
}

export interface BrowserConfig {
    browserType?: BrowserType;
    headless?: boolean;
    slowMo?: number; // milliseconds to slow down operations
    recordVideo?: boolean;
    recordScreenshots?: boolean;
    verbose?: boolean;
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

        if (this.config.verbose) console.log(`Browser ${this.config.browserType} started`);
        return this.browser;
    }

    async stop(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            if (this.config.verbose) console.log('Browser stopped');
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
    return startContext(AppConstructor, async () => {
        const browser = await startBrowser(browserConfig);
        return { sessionFactory: (backend: T, port:number) => new BrowserEmulatedSession(backend, browser, port) }
    });
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
        this.page.on('console', msg => {
            if (msg.type() == 'error' || msg.type() == 'warning') {
                console.log(`[Browser Session] ${msg.text()} [at: ${msg.location().url}] [page: ${this._page?.url()}]`)
            } else if (this.verbose) {
                console.log(`[Browser Session] ${msg.text()}`)
            }
        });
        this.page.on('pageerror', err => console.error(`[Browser Session] ${err.message} \n ${err.stack}`));
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

    protected override async fetch(path: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders:true):Promise<ResponseHeaders>
    protected override async fetch(path: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders:false):Promise<string>
    protected override async fetch(path: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders:boolean):Promise<ResponseHeaders|string> {
        if (this.verbose) console.log('to evaluate', this.baseUrl, path, method, headers, body);
        var result = await this.page.evaluate(async ({path, method, headers, body, onlyHeaders, verbose})=>{
            if (verbose) console.log('to fetch', path, method, headers, body);
            try{
                var response = await fetch('.'+path, {method, headers, body, credentials: 'include'/* , redirect: 'manual'*/});
                if (verbose) console.log('response', response.status);
                if (onlyHeaders) {
                    return {status: response.status, location: response.headers.get('location')};
                } else {
                    var result = await response.text();
                    if (verbose) console.log(result)
                    return result;
                }
            }catch(err){
                console.log('**** CATCHED!', err);
                throw err;
            }
        }, {path, method, headers, body: body.toString(), onlyHeaders, verbose: this.verbose});
        if (this.verbose) console.log(result)
        return result;
    }

    override async login(credentials: Credentials, opts: { returnErrorMessage?: boolean } = {}): Promise<string | null> {
        await this.initSession();
        if (!this.page) throw new Error('Browser session not initialized');
        const loginUrl = new URL('./login', this.baseUrl).toString();
        if (this.verbose) console.log('going to login page:', this.baseUrl, loginUrl);
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
        var activeUserSpan = await this.page.waitForSelector('#total-layout #active-user', { timeout: TO.loggedIn });
        discrepances.showAndThrow(await activeUserSpan.textContent(), credentials.username);
        var setup = await this.page.evaluate(() => {
            var my = (globalThis as typeof globalThis & {my?: {getLocalVar(varName:string):ClientConfig|null}}).my;
            if (my == null) throw new Error('backend-plus client (window.my) not found');
            return my.getLocalVar('setup');
        });
        if (setup == null) throw new Error('client setup not found in localStorage');
        this.config = setup;
        return null;
    }
    
    keystrokeStringOfrow<T extends string|boolean|number|Date|RealDate>(value: T){
        if (value == null) return '';
        switch (typeof value) {
        case "boolean":
            return value ? "Y" : "N";
        case "number":
            return value.toString();
        case "object":
            if (value instanceof Date) {
                // @ts-expect-error in best-globals this is not resolved as a type.
                if (value.isRealDate) return value.toDmy();
                return value.getDate()+'/'+(value.getMonth()+1)+'/'+value.getFullYear();
            }
            // @ts-ignore fallback
            return value.toString();
        default:
            return value.toLocaleString();
        }
    }

    booleanRepresentation = {no: false, yes: true, si: true, sí: true, Sí:true, Si: true} as Record<string, boolean>;
    // valueFromVisualRepresentation(representation:string|null, type:{string: Opts}):string
    valueFromVisualRepresentation(representation:string|null, type:Description):any{
        if (representation == null || representation === '') {
            if ('nullable' in type || 'optional' in type) return null;
            throw new Error(`valueFromVisualRepresentation error NUL IS not a ${JSON.stringify(type)}`)
        }
        if ('nullable' in type) return this.valueFromVisualRepresentation(representation, type.nullable);
        if ('optional' in type) return this.valueFromVisualRepresentation(representation, type.optional);
        if ('string' in type) return representation;
        if ('boolean' in type) return this.booleanRepresentation[representation];
        if ('number' in type) return parseFloat(representation);
        if ('class' in type && type.class == Date) {
            try{
                var parts = representation.split('/').map(n=>parseFloat(n)) as unknown as [number,1|2|3|4|5|6|7|8|9|10|11|12,number];
                if (this.verbose) console.log('date', representation, parts)
                return date.ymd(parts[2], parts[1], parts[0]);
            } catch (err) {
                throw err
            }
        }
        return undefined;
    }

    private async cellValue(element: ElementHandle<HTMLLIElement>, fieldDescription: Description): Promise<unknown>{
        var value = this.valueFromVisualRepresentation(await element.textContent(), fieldDescription);
        if (value !== undefined) return value;
        var typedValueJson = await element.evaluate((td): string|null => {
            var JSON4all = (globalThis as typeof globalThis & {JSON4all?: {stringify(value:unknown):string}}).JSON4all;
            if (JSON4all == null || !('getTypedValue' in td) || typeof td.getTypedValue != 'function') return null;
            return JSON4all.stringify(td.getTypedValue());
        });
        if (typedValueJson == null) {
            throw new Error(`Cannot get the value of column ${await element.getAttribute('my-colname')}: the type is not known and the cell is not a typed-control`);
        }
        return json4all.parse<unknown>(typedValueJson);
    }

    async openGrid(table: string, filter:Record<string, any>){
        if (this.verbose) console.log('================>', !!this.page)
        if (this.page == null) throw new Error("openGrid with no open page")
        const url = new URL(`./menu#table=${table}${filter ? `&ff=${json4all.toUrl(this.toFixedField(filter))}` : ``}`, this.baseUrl).toString();
        if (this.verbose) console.log('================> going to', url)
        for (var previousGrid of await this.page.$$('table.my-grid')) {
            await previousGrid.evaluate(table => {
                if ('setAttribute' in table && typeof table.setAttribute == 'function') table.setAttribute('serial-tester-previous', 'yes');
            });
        }
        await this.page.goto(url);
        if (this.verbose) console.log('================> there')
        var tableElement = await this.page.waitForSelector('table.my-grid:not([serial-tester-previous])');
        await tableElement.waitForSelector('[all-rows-displayed]', {state: 'attached'});
        return tableElement;
    }

    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new', primaryKeyValues?:undefined, opts?:SaveRecordOptions):Promise<DefinedType<T>>
    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<Partial<DefinedType<NoInfer<T>>>>, status:'update', primaryKeyValues?:any[]|null, opts?:SaveRecordOptions):Promise<DefinedType<T>>
    override async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'|'update', primaryKeyValues?:any[]|null, opts?:SaveRecordOptions):Promise<DefinedType<T>>{
        var description: Record<string, Description> = (target.description as RowDescription).object!;
        var filter = primaryKeyValues === undefined ? {} : this.getPkFilter<T>(target.table, rowToSave, primaryKeyValues);
        var tableElement = await this.openGrid(target.table, filter)
        var insButton = await tableElement.waitForSelector('button[bp-action=INS]', {state:'visible'});
        if (this.verbose) console.log('================> save record', target.table, !!insButton, (status == 'new'), rowToSave, {filter})
        const foundTableRow = async (emulator:BrowserEmulatedSession<TApp>, withPk:boolean) => {
            if (!withPk) {
                await insButton.click();
                var pkSelector = `:not([pk-values])`
                if (this.verbose) console.log('================> clicked', !!insButton)
                if (this.verbose) console.log(rowToSave, status, primaryKeyValues)
                var result = await tableElement.waitForSelector('> tbody > tr:not([pk-values]):not([dummy])', {state:'visible'});
                if (this.verbose) console.log('================> inserting column pk =', await result.getAttribute('pk-values'))
                if (this.verbose) await Promise.all([result].map(handler => emulator.explain(handler)));
            } else {
                var JsonPk = emulator.getJsonPkValues<T>(target.table, rowToSave, primaryKeyValues);
                var pkSelector = `[pk-values=${escapeCss(JsonPk)}]`
                if (this.verbose) console.log('================> search', JsonPk)
                if (this.verbose) console.log('================> searching', `> tbody > tr${pkSelector}`)
                try {
                    var result = await tableElement.waitForSelector(`> tbody > tr${pkSelector}`, {timeout: TO.noWaitMustBeThere});
                } catch (err) {
                    var error = expected(err);
                    if (error.name == 'TimeoutError' && primaryKeyValues === undefined) {
                        return null;
                    } else {
                        console.log('!!!!!!!!!!!!!!', err);
                        throw err;
                    }
                }
                if (this.verbose) console.log('================> updating column pk =', await result.getAttribute('pk-values'))
            }
            return result;
        }
        var tableRow = await foundTableRow(this, status != 'new');
        if (tableRow == null) {
            // let result = await this.saveRecord(target, rowToSave, 'update', primaryKeyValues);
            let result = await this.saveRecord(target, rowToSave as PartialOnUndefinedDeep<Partial<DefinedType<NoInfer<T>>>>, 'update', null, opts);
            if (result == null) {
                throw new Error("Error Double saveRecord fail")
            }
            return result;
        }
        var namesToEdit = Object.keys(rowToSave).filter(name => rowToSave[name] !== undefined && !(name in filter && sameValue(rowToSave[name], filter[name])));
        var notEditableNames = [] as string[];
        var namesAlreadySet = [] as string[];
        for (var nameToEdit of namesToEdit) {
            var cell = await tableRow.waitForSelector(`> [my-colname=${nameToEdit}]`, {state:'attached', timeout: TO.beLoaded});
            if (!await this.isEditableCell(cell)) {
                if (await this.cellHasValue(cell, rowToSave[nameToEdit], description[nameToEdit])) {
                    namesAlreadySet.push(nameToEdit);
                } else {
                    notEditableNames.push(nameToEdit);
                }
            }
        }
        if (notEditableNames.length) {
            throw new Error(`Columns ${notEditableNames.join(', ')} are not editable in grid ${target.table}`);
        }
        namesToEdit = namesToEdit.filter(name => !namesAlreadySet.includes(name));
        var hiddenNames = [] as string[];
        for (var nameToEdit of namesToEdit) {
            var cell = await tableRow.waitForSelector(`> [my-colname=${nameToEdit}]`, {state:'attached', timeout: TO.beLoaded});
            if (!await cell.isVisible()) hiddenNames.push(nameToEdit);
        }
        if (hiddenNames.length) {
            if (!opts?.unhide) {
                throw new Error(`Hidden columns ${hiddenNames.join(', ')} in grid ${target.table}. Use {unhide:true} in saveRecord`);
            }
            await this.unhideColumns(tableElement, hiddenNames);
        }
        var prevInputElement:ElementHandle<HTMLLIElement> | undefined;
        for(var name in rowToSave){
            if (!namesToEdit.includes(name)) {
                // skip edit, same value or undefined
            } else {
                var element = (await tableRow.waitForSelector(`> [my-colname=${name}]`, {timeout: TO.beLoaded}));
                if (this.verbose) console.log('================> have selector', !!tableRow, name, this.keystrokeStringOfrow(rowToSave[name]))
                if (prevInputElement != null && await areConsecutives(this.page, prevInputElement, element)) {
                    if (this.verbose) console.log('*tab*')
                    await this.page.keyboard.press('Tab')
                } else {
                    await element.focus();
                    await this.page.keyboard.press("Shift+End")
                    if (this.verbose) console.log('focus', name, await element.getAttribute('my-colname'));
                }
                if (await tableRow.$(`> [my-colname=${name}]:focus-within`) == null) {
                    var focusedCell = await tableRow.$('> :focus-within');
                    var focusedName = focusedCell == null ? '(outside the row)' : await focusedCell.getAttribute('my-colname');
                    throw new Error(`Focus is not in column ${name} in grid ${target.table} before typing, it is in ${focusedName}`);
                }
                await this.page.keyboard.insertText(this.keystrokeStringOfrow(rowToSave[name]));
            }
        }
        await this.page.keyboard.press("Tab")
        if (this.verbose) console.log('-------> saving');
        var touchedElements = await this.waitFinalIoStatus(target.table, tableRow, Object.keys(description).filter(name => name[0] != '$'));
        // a write-read-conflict is part of the UX: the user sees it, checks the value and retypes it once
        var conflicts = [] as {name:string, element:ElementHandle<HTMLLIElement>}[];
        var ignoreMergeConflictsIn = opts?.ignoreMergeConflictsIn ?? [];
        for (var info of touchedElements) {
            if (info["io-status"] == 'write-read-conflict' && namesToEdit.includes(info.name) && !ignoreMergeConflictsIn.includes(info.name)) {
                var shownValue = await this.cellValue(info.element, description[info.name]!);
                if (!sameValue(shownValue, rowToSave[info.name])) conflicts.push(info);
            }
        }
        if (conflicts.length) {
            if (this.verbose) console.log('================> write-read-conflict, retyping', conflicts.map(conflict => conflict.name));
            await new Promise(resolve => setTimeout(resolve, TO.beforeRetype));
            for (var conflict of conflicts) {
                await conflict.element.focus();
                await this.page.keyboard.press("Shift+End")
                await this.page.keyboard.insertText(this.keystrokeStringOfrow(rowToSave[conflict.name]));
                await this.page.keyboard.press("Tab")
                try {
                    await tableRow.waitForSelector(`> [my-colname=${conflict.name}]:not([io-status=write-read-conflict])`, {state:'attached', timeout: TO.afterRetype});
                } catch (err) {
                    if (expected(err).name != 'TimeoutError') throw err;
                    throw new Error(`Error in navigator saving record in table ${target.table}: write-read-conflict in ${conflict.name} does not change after retyping. Expected ${json4all.stringify(rowToSave[conflict.name])}, shown "${await conflict.element.textContent()}", title "${await conflict.element.getAttribute('title')}"`, {cause: err});
                }
            }
            var retouchedElements = await this.waitFinalIoStatus(target.table, tableRow, conflicts.map(conflict => conflict.name));
            for (var retouched of retouchedElements) {
                var retypedValue = await this.cellValue(retouched.element, description[retouched.name]!);
                if (retouched["io-status"] == 'write-read-conflict' || !sameValue(retypedValue, rowToSave[retouched.name])) {
                    throw new Error(`Error in navigator saving record in table ${target.table}: write-read-conflict in ${retouched.name} persists after retyping. Expected ${json4all.stringify(rowToSave[retouched.name])}, shown ${json4all.stringify(retypedValue)}, io-status ${retouched["io-status"]}`);
                }
                touchedElements = touchedElements.map(info => info.name == retouched.name ? retouched : info);
            }
        }
        if (touchedElements.some(info => info["io-status"] == "error")) {
            var errorDetails = await Promise.all(touchedElements.filter(info => info["io-status"] == "error").map(async info =>
                `${info.name}: ${await info.element.getAttribute('title')}`
            ));
            let error = new Error("Error in navigator saving record in table " + target.table + ". " + errorDetails.join('; '), {});
            // @ts-ignore
            error.code = 'UI_ERR'
            throw error;
        }
        if (this.verbose) console.log('-------> saved');
        var fieldData = await this.getFieldData(target, touchedElements)
        if (this.verbose) console.log('-------> data1', fieldData);
        if ("$allow.delete" in description) {
            fieldData["$allow.delete"] = !!await tableRow.getAttribute(`can-delete`);
        }
        if ("$allow.update" in description) {
            fieldData["$allow.update"] = !!await tableRow.getAttribute('can-update');
        }
        if (this.verbose) console.log('-------> data2', fieldData, description);
        return fieldData;
    }

    private async isEditableCell(cell: ElementHandle<HTMLLIElement>){
        var contentEditable = await cell.getAttribute('contenteditable');
        var disabled = await cell.evaluate(td => 'disabled' in td && td.disabled === true);
        return contentEditable !== 'false' && !disabled;
    }

    private async cellHasValue(cell: ElementHandle<HTMLLIElement>, value: unknown, fieldDescription: Description | undefined){
        var typed = await cell.evaluate((td): {hasTypedValue:boolean, value:unknown} =>
            'getTypedValue' in td && typeof td.getTypedValue == 'function' ? {hasTypedValue:true, value:td.getTypedValue()} : {hasTypedValue:false, value:null}
        );
        if (typed.hasTypedValue && sameValue(typed.value, value)) return true;
        var shown = await cell.textContent();
        if (shown == null || shown === '') return value == null;
        if (fieldDescription == null) return false;
        return sameValue(this.valueFromVisualRepresentation(shown, fieldDescription), value);
    }

    private async waitFinalIoStatus(table: string, tableRow: ElementHandle<HTMLLIElement>, columnNames: string[]){
        var finalStatuses = ['temporal-ok', 'ok', 'error', 'write-read-conflict'];
        try {
            return await Promise.all(columnNames.map(async (name) => {
                var element = await tableRow.waitForSelector(
                    finalStatuses.map(status => `> [my-colname=${name}][io-status=${status}]`).concat(`> [my-colname=${name}]:not([io-status])`).join(', '),
                    {state:'attached'}
                );
                return {name, element, "io-status": await element.getAttribute('io-status')};
            }));
        } catch (err) {
            var error = expected(err);
            if (error.name != 'TimeoutError') throw err;
            var rowConnected = await tableRow.evaluate(tr => 'isConnected' in tr && tr.isConnected === true);
            var ioStatuses = await Promise.all(columnNames.map(async name => {
                var cell = await tableRow.$(`> [my-colname=${name}]`);
                return `${name}=${cell == null ? '(no cell)' : await cell.getAttribute('io-status')}`;
            }));
            try {
                var screenshot = await this.takeScreenshot(`saveRecord-${table}`);
            } catch (errScreenshot) {
                var screenshot = `(screenshot failed: ${expected(errScreenshot).message})`;
            }
            throw new Error(`Timeout waiting final io-status saving record in table ${table}. Row connected: ${rowConnected}. io-status: ${ioStatuses.join(', ')}. Screenshot: ${screenshot}`, {cause: err});
        }
    }

    private async unhideColumns(tableElement: ElementHandle<HTMLLIElement>, columnNames: string[]){
        var menuButton = await tableElement.waitForSelector('button[bp-action=MENU]', {state:'visible', timeout: TO.beLoaded});
        await menuButton.click();
        var menuOption = await this.page.waitForSelector('#menu-hide-or-show', {state:'visible', timeout: TO.beLoaded});
        await menuOption.click();
        var selectToShow = await this.page.waitForSelector('select#show-columns', {state:'visible', timeout: TO.beLoaded});
        var hiddenColumns = await selectToShow.$$eval('option', options => options.map(option => option.value));
        var columnsToShow = columnNames.filter(name => hiddenColumns.includes(name));
        if (this.verbose) console.log('================> unhide', columnsToShow);
        if (columnsToShow.length) {
            await selectToShow.selectOption(columnsToShow);
        }
        var okButton = await this.page.waitForSelector('button.hide-or-show', {state:'visible', timeout: TO.beLoaded});
        await okButton.click();
    }

    private async getFieldData<T extends Description>(target: {table: string, description:T}, pairsNameElement:{name:string, element:ElementHandle<HTMLLIElement>}[]){
        if (this.verbose) console.log('================> entro')
        if (!('object' in target.description)) throw new Error('description must be {object:{...}}');
        var description: Record<string, Description> = target.description.object;
        if (this.verbose) console.log('================> veo', description)
        var touched = await Promise.all(
                pairsNameElement.map(
                    async ({name, element}) => [name, await this.cellValue(element, description[name]!)]
                )
            )
        if (this.verbose) console.log('================> acá', touched)
        var result = Object.fromEntries(
            touched
        );
        if (this.verbose) console.log('================> ufs', result)
        return result;
        // return guarantee(target.description, result);
    }

    private async getAllVisibleRowsFromGrid<T extends Description>(target: {table: string, description:T}, tableElement: ElementHandle<HTMLLIElement>, columnNames:string[]):Promise<DefinedType<T>[]>{
        if (this.verbose) console.log('~~~~~~~~~~~~>', target.table);
        try {
            var buttonToGetAllRows = await tableElement.waitForSelector('[all-rows-displayed]', {state: 'attached'});
            if (this.verbose) console.log('~~~~~~~~~~~~>', !!buttonToGetAllRows);
            if (await buttonToGetAllRows.getAttribute('all-rows-displayed') == "no") {
                if (this.verbose) console.log('------------> get all rows')
                await buttonToGetAllRows.click()
            }
            await tableElement.waitForSelector('[all-rows-displayed=yes]', {state: 'attached'});
            if (this.verbose) console.log('~~~~~~~~~~~~>', 'están todos:');
            var trows = await tableElement.$$(':scope > tbody > tr');
            if (this.verbose) console.log('~~~~~~~~~~~~>', trows.length);
            if (this.verbose) console.log('~~~~~~~~~~~~>', await Promise.all(trows.map(async e=>(await e.getProperty('id')).jsonValue())));
            var result = await Promise.all(trows.map(async row => this.getFieldData(target, await this.tdForNames(row, columnNames))));
            if (this.verbose) console.log('~~~~~~~~~~~~>', 'ufs');
            return result;
        }catch(err){
            throw unexpected(err);
        }
    }

    private async tdForNames(tableElement: ElementHandle<HTMLLIElement>, columnNames: string[]){
        // var id=Math.random()
        // console.log('************', columnNames,id)
        // return Promise.all(columnNames.map(async name => ({name, element: (await tableElement.waitForSelector(`[my-colname=${name}]`, {timeout: TO.noWaitMustBeThere}))!})));
        return Promise.all(columnNames.map(async name => {
            // console.log('¿?', name, id)
            var x = await tableElement.waitForSelector(`[my-colname=${name}]`, {timeout: TO.noWaitMustBeThere});
            // console.log('ok', name, id);
            return ({name, element: x})
        }));
    }

    override async tableDataTest<T extends Description>(target: {table: string, description:T} | string, rows: Row[], compare: 'all', opts?: TableDataTestOptions): Promise<void> {
        if (typeof target == "string") throw new Error("must use {table, description} in tableDataTest for Navigators")
        if (this.verbose) console.log('############>', target.table);
        var tableElement = await this.openGrid(target.table, opts?.fixedFields ?? {});
        if (this.verbose) console.log('############>', !!tableElement);
        var fixedFieldPairs = this.toFixedField(opts?.fixedFields);
        rows = rows.map(row => {
            for (const pair of fixedFieldPairs) {
                var name = pair.fieldName;
                var ffv = pair.value;
                if (row[name]?.isRealDate && typeof ffv == "string") {
                    ffv = date.iso(ffv);
                }
                if (!(name in row) || pair.until !== undefined) {
                    // ok!
                } else if (sameValue(row[name], ffv)) {
                    delete row[name];
                } else {
                    console.log(`Error in fixedFields in tableDataTest doesn't match the rows`, row[name], pair.value);
                    throw new Error(`Error in fixedFields in tableDataTest doesn't match the rows in ${name} field`)
                };
            }
            return row;
        });
        var objectDescription: Record<string, Description> = 'object' in target.description ? target.description.object : {};
        var columnNames = (rows.length ? Object.keys(rows[0]!) : [])
        var columnsNotInDescription = columnNames.filter(name => !objectDescription[name]);
        if (columnsNotInDescription.length) {
            throw new Error(`tableDataTest: columns ${columnsNotInDescription.join(', ')} expected in rows but not in description of ${target.table}`);
        }
        if (opts?.unhide) {
            await this.unhideColumns(tableElement, columnNames);
        }
        var response = await this.getAllVisibleRowsFromGrid(target, tableElement, columnNames);
        for (const row of response) {
            for (const pair of fixedFieldPairs) {
                if (pair.until === undefined && row[pair.fieldName] == null) row[pair.fieldName] = pair.value;
            }
        }
        if (this.verbose) console.log('############>', response);
        this.compareRows(response, rows, compare);
        if (this.verbose) console.log('############>', 'ok!');
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