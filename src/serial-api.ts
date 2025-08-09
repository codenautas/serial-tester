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

export async function startBackendAPIContext<T extends AppBackend>(AppConstructor: AppBackendConstructor<T>):Promise<Contexts<T>>{
    const backend = await startServer(AppConstructor);
    return {backend, createSession: () => new EmulatedSession(backend, backend.config.server.port)};
}

export type AnyValue = string|number|Date|boolean|null
export type Row = Record<string, any>

export type Credentials = {username:string, password:string}

export type FixedFields = {fieldName:string, value:any, until?:AnyValue}[]
export type EasyFixedFields = null|undefined|FixedFields|Record<string,AnyValue|[AnyValue, AnyValue]>

export type Methods = 'get'|'post'|'put'|'patch'|'delete'|'head'

export interface ClientConfig{
    config: AppConfigClientSetup
}

export type ResultAs = 'JSON+' | 'text' | 'JSON' | 'bp-login-error';

export interface Contexts<TApp extends AppBackend>{
    backend: TApp;
    createSession: () => EmulatedSession<TApp>;
}

export class EmulatedSession<TApp extends AppBackend>{
    protected baseUrl:string
    public tableDefs: Record<string, TableDefinition> = {}
    private cookies:string[] = []
    public config:ClientConfig | undefined
    public parseResult: ResultAs = 'JSON+';
    protected server:TApp
    constructor(engines: TApp, port:number){
        this.server = engines;
        this.baseUrl = `http://localhost:${port}${this.server.config.server["base-url"]}/`;
    }
    async request(params:{path:string, payload:any, onlyHeaders:boolean}):ReturnType<typeof fetch>;
    async request<T = any>(params:{path:string, method:'get', parseResult:'text'}):Promise<string>;
    async request<T = any>(params:{path:string, method:'get', parseResult:ResultAs}):Promise<T>;
    async request<T = any>(params:{path:string, payload:any}):Promise<T>;
    async request(params:{path:string, payload?:any, onlyHeaders?:boolean, method?:Methods, parseResult?:ResultAs}):Promise<any> {
        const {path, payload} = params;
        const method = params.method ?? 'post';
        const onlyHeaders = params.onlyHeaders ?? (method == 'head' ? true : false);
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
        var response = await fetch(target, {method, headers, body, redirect: 'manual'});
        this.cookies = response.headers.getSetCookie();
        if (onlyHeaders) {
            return response;
        } else {
            return this.getResult(response, parseResult);
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
        // return result;
        return guarantee(target.result, result);
    }
    async getResult(request:Awaited<ReturnType<typeof fetch>>, parseResult?:ResultAs){
        var result = await request.text();
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
            console.log("notices")
            console.log(notices)
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
        var request = await this.request({path:'/login', payload, onlyHeaders:true});
        if (request.status != 302) throw new Error("se esperaba una redirección");
        var result = request.headers.get('location');
        if (result?.replace(/^\./, '') != this.server.config.login.plus.successRedirect){
            if (opts.returnErrorMessage) {
                var errorMessage = await this.request({path:result!, method:'get', parseResult:'bp-login-error'});
                return errorMessage;
            } else {
                discrepances.showAndThrow(result?.replace(/^\./,''), this.server.config.login.plus.successRedirect);
                return result;
            }
        } else {
            this.config = await this.request<ClientConfig>({path:'/client-setup', method:'get', parseResult:'JSON'});
            return null;
        }
    }
    async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'):Promise<DefinedType<T>>
    async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<Partial<DefinedType<NoInfer<T>>>>, status:'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>
    async saveRecord<T extends Description>(target: {table: string, description:T}, rowToSave:PartialOnUndefinedDeep<DefinedType<NoInfer<T>>>, status:'new'|'update', primaryKeyValues?:any[]):Promise<DefinedType<T>>{
        var context = this.server.getContextForDump();
        const {table, description} = target
        if (this.server.tableStructures[table] == null) {
            throw new Error(`table "${table}" not found in server.tableStructures`);
        }
        var tableDef = this.server.tableStructures[table](context);
        var result = await this.request({
            path:'/table_record_save',
            payload:{
                table,
                primaryKeyValues: JSON4all.stringify(primaryKeyValues ?? tableDef.primaryKey.map(f => rowToSave[f])),
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
    async tableDataTest(table:string, rows:Row[], compare:'all',opts?:{fixedFields?:EasyFixedFields}){
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
        if (rows.length > 0) {
            var existColumn = LikeAr(rows[0]!).map(_ => true).plain();
            var filteredReponseRows = response.map(row => LikeAr(row).filter((_,k) => !!existColumn[k]).plain());
        } else {
            var filteredReponseRows = response;
        }
        switch(compare){
            case 'all': 
                try{
                    discrepances.showAndThrow(filteredReponseRows, rows);
                } catch (err) {
                    // console.log('======================================',rows.length == 0 ? response : filteredReponseRows, rows)
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