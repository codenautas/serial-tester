import { AppBackend, AppConfigClientSetup, TableDefinition } from 'backend-plus';
import * as MiniTools from 'mini-tools';
import { expected } from "cast-error";
import { promises as fs } from 'fs';
import { strict as LikeAr } from 'like-ar';
import { Description, guarantee, is, DefinedType } from "guarantee-type";
import * as JSON4all from 'json4all';
import { sameValue } from 'best-globals'

import { PartialOnUndefinedDeep } from 'type-fest';

import * as Path from 'path';

import * as discrepances from 'discrepances';

export type AppBackendConstructor<T> = new() => T;

export type RowDescription = {object: Record<string, Description>}

declare module "backend-plus"{
    interface AppConfig{
        test?:{
            "only-in-db"?: string
        }
    }
}

export async function startServer<T extends AppBackend>(AppConstructor: AppBackendConstructor<T>):Promise<T>{
    var server = new AppConstructor();
    await server.start();
    var config = await MiniTools.readConfig(
        [server.config],
        {whenNotExist:'ignore'}
    );
    // var client = await pg.connect(config.db);
    // await client.executeSqlScript('test/fixtures/dump-4test.sql');
    if (config.devel.delay && (isNaN(config.devel.delay) || config.devel.delay > 10)) {
        console.error('************************ WARNING ************************')
        console.error('config.devel.delay', config.devel.delay, 'deberia ser <= 10 para tests')
    }
    if (config.test?.["only-in-db"] == null) {
        console.error('************************ WARNING ************************')
        console.error('No se encuentra la cofiguracion de seguridad en test.only-in-db')
        console.error('Colocar ahi el nombre de la base de datos a usar.')
        console.error('Solo en esa base de datos se van a crear y modificar datos para test.')
    } else if (config.test?.["only-in-db"] != config.db.database) {
        console.error('************************ WARNING ************************')
        console.error(`"${config.db.database}" no es la base de datos de test.only-in-db = ${config.test?.["only-in-db"]}`);
        process.exit(0);
    }
    try {
        fs.unlink('local-log-all.sql')
    } catch (err) {
        if (expected(err).code != 'ENOENT') throw err;
    }
    server.setLog({until:'5m'});
    return server;
}

export async function startContext<T extends AppBackend>(
    AppConstructor: AppBackendConstructor<T>, 
    getInternals: () => Promise<{
        sessionFactory: (backend:T, port:number) => EmulatedSession<T>
    }>
){
    const backend = await startServer(AppConstructor);
    const context:Partial<Contexts<T>> = {backend};
    const internals  = await getInternals();
    context.createSession = () => {
        const session = internals.sessionFactory(backend, backend.config.server.port);
        if (context.verbose) session.verbose = context.verbose;
        return session;
    }
    return context as Contexts<T>;
}

export async function startBackendAPIContext<T extends AppBackend>(AppConstructor: AppBackendConstructor<T>):Promise<Contexts<T>>{
    return startContext(AppConstructor, async () => ({sessionFactory:(backend: T, port:number) => new EmulatedSession(backend, port)}));
}

export type AnyValue = string|number|Date|boolean|null
export type Row = Record<string, any>

export type Credentials = {username:string, password:string}

export type FixedFields = {fieldName:string, value:any, until?:AnyValue}[]
export type EasyFixedFields = null|undefined|FixedFields|Record<string,AnyValue|[AnyValue, AnyValue]>

export type Methods = 'get'|'post'|'put'|'patch'|'delete'|'head'
export type ResponseHeaders = {status:number, location:string|null}


export interface ClientConfig{
    config: AppConfigClientSetup
}

export type ResultAs = 'JSON+' | 'text' | 'JSON' | 'bp-login-error';

export interface Contexts<TApp extends AppBackend>{
    backend: TApp;
    verbose?: boolean;
    createSession():EmulatedSession<TApp>;
}

export class EmulatedSession<TApp extends AppBackend>{
    protected baseUrl:string
    public tableDefs: Record<string, TableDefinition> = {}
    private cookies:string[] = []
    public config:ClientConfig | undefined
    public parseResult: ResultAs = 'JSON+';
    public verbose: boolean = false;
    protected server:TApp
    constructor(engines: TApp, port:number){
        this.server = engines;
        this.baseUrl = `http://localhost:${port}${this.server.config.server["base-url"]}/`;
    }
    protected async fetch(target: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders:true):Promise<ResponseHeaders>
    protected async fetch(target: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders?:false):Promise<string>
    protected async fetch(target: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders?:boolean):Promise<ResponseHeaders|string>
    protected async fetch(target: string, method: Methods, headers: Record<string, string>, body: any, onlyHeaders?:boolean):Promise<ResponseHeaders|string> {
        var response = await fetch(target, {method, headers, body, redirect: 'manual'});
        this.cookies = response.headers.getSetCookie();
        if (onlyHeaders) {
            return {status: response.status, location: response.headers.get('location')};
        } else {
            return await response.text()
        }
    }
    protected async request(params:{path:string, payload:any, onlyHeaders:true}):Promise<ResponseHeaders>;
    protected async request<T = any>(params:{path:string, method:'get', parseResult:'text'}):Promise<string>;
    protected async request<T = any>(params:{path:string, method:'get', parseResult:ResultAs}):Promise<T>;
    protected async request<T = any>(params:{path:string, payload:any}):Promise<T>;
    protected async request(params:{path:string, payload?:any, onlyHeaders?:true, method?:Methods, parseResult?:ResultAs}):Promise<any> {
        const {path, payload} = params;
        const method = params.method ?? 'post';
        const onlyHeaders:boolean|undefined = params.onlyHeaders ?? (method == 'head' ? true : false);
        const parseResult = params.parseResult ?? (method == 'get' ? 'text' : this.parseResult);
        var body = payload == null ? payload : new URLSearchParams(payload);
        var headers = {} as Record<string, string>
        if (payload != null) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        if (this.cookies.length > 0) {
            headers.Cookie = this.cookies.map(c => c.split(';')[0]).join('; ');
        }
        var target = Path.posix.join(this.baseUrl, path);
        var result = await this.fetch(target, method, headers, body, onlyHeaders)
        if (typeof result == "string") {
            return this.getResult(result, parseResult);
        } else {
            return result;
        }
    }
    async callProcedure<T extends Description, U extends Description>(
        target:{procedure:string, parameters:T, result:U}, 
        params:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>
    ):Promise<DefinedType<NoInfer<U>>>{
        var mandatoryParameters = target.parameters;
        var result = await this.request({
            path: '/'+target.procedure,
            payload: {
                // @ts-ignore no logra deducir el null
                ...(LikeAr(mandatoryParameters).map(_ => null).plain()),
                ...(LikeAr(params).map(value => JSON4all.stringify(value)).plain())
            }
        })
        return guarantee(target.result, result);
    }
    protected async getResult(result:string, parseResult?:ResultAs){
        switch (parseResult) {
        case 'text':
            return result;
        case 'JSON+':
            var lines = result.split(/\r?\n/);
            var notices:string[] = []
            do {
                var line = lines.shift();
                if (line == '--') return JSON4all.parse( lines.shift() || 'null')
                try{
                    var obj = JSON4all.parse( line || '{}' ) as {error:{message:string, code:string}};
                }catch(err){
                    console.log('Json error:',line)
                    throw err; 
                }
                if (obj.error) {
                    const error = expected(new Error("Backend error: " + obj.error.message));
                    error.code = obj.error.code;
                    throw error;
                }
                if (line != null) notices.push(line);
            } while (lines.length);
            if (notices.length) {
                if (this.verbose) console.log("notices")
                if (this.verbose) console.log(notices)
            }
            throw new Error('result not received');
        case 'bp-login-error':
            return result.match(/\berror-message[^>]*>([^<]*)</)?.[1];
        default:
            var directResult = JSON4all.parse(result);
            return directResult;
        }
    }
    async login(credentials: Credentials, opts:{returnErrorMessage?:boolean} = {}) {
        var payload = credentials;
        var result = await this.request({path:'/login', payload, onlyHeaders:true});
        if (result.status != 302) throw new Error("se esperaba una redirección");
        var location = result.location;
        if (location?.replace(/^\./, '') != this.server.config.login.plus.successRedirect){
            if (opts.returnErrorMessage) {
                var errorMessage = await this.request({path:location!, method:'get', parseResult:'bp-login-error'});
                return errorMessage;
            } else {
                discrepances.showAndThrow(location?.replace(/^\./,''), this.server.config.login.plus.successRedirect);
                return location;
            }
        } else {
            this.config = await this.request<ClientConfig>({path:'/client-setup', method:'get', parseResult:'JSON'});
            return null;
        }
    }
    async closeSession(): Promise<void> {
        this.config = null!;
    }
    getJsonPkValues<T extends Description>(table: string, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, primaryKeyValues:undefined|null|any[]): string {
        if (this.server.tableStructures[table] == null) {
            throw new Error(`table "${table}" not found in server.tableStructures`);
        }
        var context = this.server.getContextForDump();
        var tableDef = this.server.tableStructures[table](context);
        return JSON4all.stringify(primaryKeyValues ?? tableDef.primaryKey.map(f => rowToSave[f]));
    }
    async saveRecord<T extends RowDescription>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'):Promise<DefinedType<T>>
    async saveRecord<T extends RowDescription>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<Partial<DefinedType<NoInfer<T>>>>, status:'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>
    async saveRecord<T extends RowDescription>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'|'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>{
        const {table, description} = target
        var result = await this.request({
            path:'/table_record_save',
            payload:{
                table,
                primaryKeyValues: this.getJsonPkValues(table, rowToSave, primaryKeyValues),
                newRow: JSON4all.stringify(rowToSave),
                oldRow: JSON4all.stringify({}),
                status
            }
        })
        var command:string = result.command;
        var row = guarantee(description, result.row);
        discrepances.showAndThrow(command, discrepances.test(x => x=='INSERT' || x=='UPDATE'));
        return row;
    }
    toFixedField(param:EasyFixedFields): FixedFields{
        if (param == null) return [];
        if (param instanceof Array) return param;
        const result = Object.keys(param).map(fieldName => {var value = param[fieldName]; return value instanceof Array ? {fieldName, value:value[0], until:value[1]} : {fieldName, value}})
        return result;
    }
    async tableDataTest<T extends Description = any>(target: {table: string, description:T} | string, rows: Row[], compare: 'all', opts?: { fixedFields?: EasyFixedFields; }): Promise<void>{
        var table = typeof target == "string" ? target : target.table;
        var result = await this.request({
            path:'/table_data',
            payload:{
                table,
                paramFun:'{}',
                ...opts,
                fixedFields:JSON.stringify(this.toFixedField(opts?.fixedFields))
            }
        })
        var response = guarantee({array:is.object({})}, result);
        this.compareRows(response, rows, compare);
    }
    protected compareRows(obtained: Record<string,any>[], expected:Record<string,any>[], compare:string){
        if (expected.length > 0) {
            var existColumn = LikeAr(expected[0]!).map(_ => true).plain();
            var filteredReponseRows = obtained.map(row => LikeAr(row).filter((_,k) => !!existColumn[k]).plain());
        } else {
            var filteredReponseRows = obtained;
        }
        switch(compare){
            case 'all': 
                try{
                    discrepances.showAndThrow(filteredReponseRows, expected);
                } catch (err) {
                    if (this.verbose) console.log('======================================', filteredReponseRows, expected)
                    throw err;
                }
            break;
            default:
                throw new Error('mode not recognized '+compare);
        }
    }
    async tableDataSaveAndTest(table:string, rows:Row[], compare:'all', status:'new'){
        for (var row of rows) {
            await this.saveRecord({table, description:is.object({})}, row, status);
        }
        return this.tableDataTest(table, rows, compare);
    }
}

export function expectError(action: ()=>void              , check: string): void              ;
export function expectError(action: ()=>     Promise<void>, check: string):      Promise<void>;
export function expectError(action: ()=>void|Promise<void>, check: string): void|Promise<void>{
    var allOk = false;
    function itDidntFail() {
        allOk = true;
        throw new Error("serial-tester: itDidntFail")
    }
    function checkExpected(err:Error|unknown) {
        if (allOk) throw new Error("expectError -> not ERROR!");
        var error = expected(err);
        if (error.code != check) {
            console.log(`Expected "${check}" error code. Gotten "${error.code}:  ${error.message}"`)
            throw err;
        }
    }
    try { 
        var result = action();
        if (result instanceof Promise) {
            return result.then(itDidntFail).catch(checkExpected)
        }
        return itDidntFail();
    } catch (err) {
        checkExpected(err);
    }
}

export async function loadLocalFile<T>(empty:T, fileNameOrBP_TEST_BENCHMARKS?:string): Promise<T>{
    try {
        const fileName = fileNameOrBP_TEST_BENCHMARKS ?? `local-${process.env.BP_TEST_BENCHMARKS}.json4all`;
        if (!fileName) return empty;
        const raw = await fs.readFile(fileName, 'utf-8');
        var json = JSON4all.parse<T>(raw);
        return json;
    } catch (err) {
        var error = expected(err);
        if (error.code == 'ENOENT') {
            return empty
        }
        throw error;
    }
}

export async function saveLocalFile<T>(data:T, fileNameOrBP_TEST_BENCHMARKS?:string, transform?:(data:T)=>string): Promise<void>{
    const fileName = fileNameOrBP_TEST_BENCHMARKS ?? `local-${process.env.BP_TEST_BENCHMARKS}.json4all`;
    if (!fileName) return;
    return fs.writeFile(fileName, (transform ?? JSON4all.toUrl)(data), 'utf-8');
}

export async function benchmarksSave(benchmark:any){
    if (process.env.BP_TEST_BENCHMARKS) {
        const fileName = `benchmarks/${process.env.BP_TEST_BENCHMARKS}.json4all`;
        var benchmarks = await loadLocalFile([] as {date:Date}[], fileName)
        if (benchmarks.length && sameValue(benchmark.date, benchmarks[benchmarks.length -1]!.date)) {
            benchmarks.pop();
        }
        benchmarks.push(benchmark);
        await fs.writeFile(fileName, JSON4all.toUrlLines(benchmarks, '\r\n'));
    }
}

type MochaTypes = Mocha.Suite|Mocha.Suite[]|Mocha.Runnable|Mocha.Test|Mocha.Test[];

function checkVisited<T extends MochaTypes>(visited:MochaTypes[], item:T|undefined): item is undefined{
    if (item == null) return true;
    if (visited.includes(item)) return true;
    visited.push(item);
    return false;
}

function isMochaSuite(item:MochaTypes): item is Mocha.Suite{
    return item.constructor.name == 'Suite';
}

function checkMochaElementHasError(visited:MochaTypes[], item:MochaTypes|undefined){
    if (checkVisited(visited, item)) return false;
    if (item instanceof Array) {
        for (var element of item) {
            if (checkMochaElementHasError(visited, element)) return true;
        }
        return false;
    }
    if (checkMochaElementHasError(visited, item.parent)) return true;
    if (isMochaSuite(item)) {
        if (checkMochaElementHasError(visited, item.suites)) return true;
        if (checkMochaElementHasError(visited, item.tests)) return true;
        return false;
    }
    if (item.state != 'passed' && item.state != 'pending' && item.state != null) {
        console.log("TEST FAILED", item.state, item.title)
        return true;
    }
    return false;
}

export function someTestFails(testSuite:Mocha.Context){
    var visited:MochaTypes[] = [];
    return checkMochaElementHasError(visited, testSuite.test)
}