# 言語別の落とし穴

対象言語のセクションだけ読む。共通のパターンは `bug-patterns.md` と `security-checklist.md` にあり、ここは「その言語だと特にこう間違える」もの。

## Go

- **nil**: nil map への書き込みは panic、nil slice への append は OK。インターフェース値の nil 判定（型付き nil は `!= nil`）。nil ポインタのメソッド呼び出しはメソッド内でデリファレンスするまで落ちない
- **エラー**: `err` の shadowing（`:=` で内側のスコープに別の err）、`if err != nil` の後に `return` が無い、`errors.Is`/`As` でなく `==` で比較（ラップされていると一致しない）、`defer f.Close()` の戻り値無視（書き込みファイルでは close エラーが実エラー）
- **defer**: ループ内の defer は関数終了まで溜まる。defer の引数は defer 時点で評価される。`defer mu.Unlock()` を取り忘れると後続でデッドロック
- **goroutine**: ループ変数のキャプチャ（Go 1.22 未満）、`sync.WaitGroup` の `Add` が goroutine 内、`wg.Wait()` 前の `return`、`context` を渡していない goroutine は止められない、`select` に `ctx.Done()` が無い、チャネルの受信者がいないとブロックして goroutine リーク（`errgroup` や buffered channel で逃がす）
- **map/slice**: map の並行読み書きは fatal（`-race` で検出）。slice の `append` が元の配列を共有する（部分スライスを渡して書き換えると呼び出し元が変わる）。`copy` の戻り値を見ていない
- **整数**: `int` は 64bit でも `int32` にキャストすると切り詰め。`len()` を `uint` と比較、`time.Duration` に int を掛けるときの単位（`time.Second * n` は OK、`n * 1000` はナノ秒）
- **文字列**: `len(s)` はバイト長、`s[i]` はバイト、`for i, r := range s` は rune。`strings.ToLower` の前に比較しない
- **HTTP**: `http.Client{}` にタイムアウトなし（デフォルト無限）、`resp.Body.Close()` 忘れ、`r.Body` を `io.ReadAll` でサイズ制限なし（`http.MaxBytesReader`）、`r.FormValue` が先に呼ばれると `ParseMultipartForm` のサイズ制限が効かない
- **セキュリティ**: `math/rand` でトークン、`template.HTML(userInput)`、`text/template` で HTML 出力、`filepath.Join` だけでパストラバーサル対策とする（`filepath.Clean` 後に `strings.HasPrefix(base + sep)` が必要）、`exec.Command("sh", "-c", s)`、`InsecureSkipVerify`、`sql.DB` で `fmt.Sprintf` クエリ、`gorm` の `Where(fmt.Sprintf)`、`unsafe`
- **その他**: 構造体のコピーで `sync.Mutex` がコピーされる（`go vet` copylocks）、`time.Now()` と `time.Since` の単調時計、`json.Unmarshal` で未知フィールド無視（`DisallowUnknownFields`）、`omitempty` でゼロ値が消える（`0` や `false` が送られない）

## Python

- **可変デフォルト引数** `def f(x, acc=[])`、クラス属性の可変オブジェクト共有
- **真偽値**: `if x:` は `0`、`""`、`[]`、`None` を区別しない。`is None` と `== None`。`if not items` で「空」と「None」を混同
- **例外**: 裸 `except:` / `except Exception: pass`、`finally` 内の `return` が例外を握りつぶす、`KeyError` vs `.get()` の既定値、`StopIteration`
- **文字列**: `str` と `bytes`、エンコーディング未指定の `open()`（環境依存）、`.strip()` が引数を文字集合として扱う、f-string に SQL/コマンド
- **数値**: `int` は任意精度だが `//` と `%` の負数の挙動、`round()` の銀行丸め、`float` の `==`、`Decimal` と `float` の混在
- **並行**: GIL があっても I/O と `+=` は原子的でない、`threading` で共有 dict、`asyncio` で同期 I/O を呼ぶ（イベントループを止める）、`await` 忘れ（コルーチンが作られるだけ）、`asyncio.create_task` の参照を保持しない（GC で消える）
- **セキュリティ**: `pickle.loads`、`yaml.load` without `SafeLoader`、`eval`/`exec`、`subprocess(shell=True)`、`os.system`、`tempfile.mktemp`（レース）、`random` で秘密、`hashlib.md5` でパスワード、`requests(verify=False)`、`flask` の `send_file` に未検証パス、`jinja2.Template(user_input)`、`__import__`、`getattr(obj, user_input)`、`format(**user)` による属性アクセス、`tarfile.extractall` without filter、`os.path.join` で絶対パスが勝つ
- **Django/Flask/FastAPI**: `.raw()`/`.extra()`/`RawSQL`、`mark_safe`/`|safe`、`@csrf_exempt`、`DEBUG=True`、`ALLOWED_HOSTS=['*']`、Pydantic の `extra='allow'` でマスアサインメント、FastAPI の依存注入で認可を忘れたルート、Flask の `request.args.get` の型は常に str
- **型**: Optional を返す関数の戻り値をそのまま使う、`dict` のキー存在を仮定、`isinstance` 無しのダックタイピング、`TypedDict` は実行時検証しない

## JavaScript / TypeScript

- **型強制**: `==`、`+` の文字列連結、`parseInt` の基数と `NaN`、`Number("")` が 0、`typeof null === "object"`、`Array.isArray`、`"0"` は truthy
- **非同期**: `await` 忘れ、`forEach` 内の `async`（待たない）、`Promise.all` の一つが reject で全体 reject・残りは走り続ける、unhandled rejection、`try/catch` が非同期エラーを捕まえない（await なし）、Express のハンドラで async エラーが next に渡らない（Express 4）、イベントループを止める同期 I/O と長いループ
- **参照**: オブジェクト・配列の共有（浅いコピー）、スプレッド `{...defaults}` は 1 段しかコピーしないのでネストを in-place で merge すると `defaults` 側が書き換わる（モジュールレベルの既定値 + 再帰マージは要確認）、`sort()` が破壊的、`splice` vs `slice`、クロージャとループ変数（`var`）
- **数値**: `2^53` を超える整数（ID、金額を整数で持つとき）、`0.1 + 0.2`、`Date` のタイムゾーン・月が 0 始まり、`toFixed` の丸め
- **TypeScript 固有**: `as` / `!` / `any` で型チェックを外した箇所（実行時検証がない）、`strictNullChecks` オフ、JSON の `parse` 結果を型アサーションで信用、enum の数値逆引き、`Record<string, T>` のキー存在を仮定、オプショナルチェーン後の `undefined` を使う
- **セキュリティ**: `eval`/`new Function`/`setTimeout(string)`、`innerHTML`/`dangerouslySetInnerHTML`/`v-html`、`child_process.exec`（`execFile`/`spawn` with 配列へ）、`path.join` だけでトラバーサル対策、`fs` with ユーザーパス、`jwt.decode` を verify の代わりに・`algorithms` 未指定、`Object.assign`/`lodash.merge`/再帰マージで `__proto__`（プロトタイプ汚染）、`req.query` が配列・オブジェクトにもなる（`?id[]=1`）、`express.json()` のサイズ制限、正規表現 ReDoS（`(a+)+`、`.*` の連続）、`res.redirect(req.query.next)`、`cors({origin: true})`、`crypto.randomBytes` でなく `Math.random`、`setHeader` に外部入力（CRLF）、`new RegExp(userInput)`、テンプレートリテラルで SQL（`db.query(\`... ${x}\`)`）、`Sequelize.literal`/`knex.raw`/`$queryRawUnsafe`
- **Node 固有**: `process.on('uncaughtException')` で継続、ストリームの `error` イベント未処理、`Buffer(n)` の未初期化、`fs.exists` → `fs.open` の TOCTOU、`require(userInput)`

## Java / Kotlin

- **null**: Java の NPE（Optional の `get()`、`Map.get` の null、自動アンボクシング）、Kotlin の `!!`、プラットフォーム型（Java から来た値）
- **equals/hashCode** の不整合、`==` で文字列・Integer（キャッシュ範囲外で false）
- **並行**: `HashMap` の並行書き込み、`SimpleDateFormat` の共有、`synchronized` の対象が違う、`volatile` 無しの可視性、`ExecutorService` の shutdown 忘れ、`CompletableFuture` の例外が `join` まで出ない、Kotlin コルーチンの `GlobalScope`
- **リソース**: try-with-resources 無しのストリーム・接続、`finally` での close 例外
- **整数**: `int` オーバーフロー（`Math.addExact`）、`long` と `int` の混在、`Integer.parseInt` の例外
- **セキュリティ**: `Statement` + 連結、`ObjectInputStream.readObject`、XXE（`DocumentBuilderFactory` のデフォルト）、`Runtime.exec` with 文字列、`new Random()`、`MessageDigest.isEqual` でない比較、`X509TrustManager` の空実装、`HostnameVerifier` の `return true`、Spring の `@RequestBody` でマスアサインメント、`@PreAuthorize` の欠落、Thymeleaf の `th:utext`、JNDI 参照、`Class.forName(userInput)`、`ZipInputStream` の zip slip、`File` with 連結パス

## Rust

- `unwrap()`/`expect()`/`panic!`/配列添字 on 外部入力（サーバで panic = DoS）、`as` キャストの切り詰め・符号変換、整数オーバーフロー（release では wrap）、`unsafe` ブロックの不変条件、`RefCell` の二重借用 panic、`Mutex` の poison、`Rc` の循環参照、`std::process::Command` with `sh -c`、`Path::join` で絶対パスが勝つ、`.await` を持ちながらロック（`std::sync::Mutex` in async）、`tokio::spawn` の JoinHandle 放置、`unwrap_or_default` で失敗を隠す

## C / C++

- バッファ長（`strcpy`、`sprintf`、`strncpy` の非終端）、off-by-one、符号付き/符号なし比較、整数オーバーフローからの小さい `malloc`、use-after-free、二重 free、未初期化、`memcpy` の重なり、フォーマット文字列、戻り値未チェック（`malloc`、`fopen`、`read` の部分読み）、`errno` の上書き、スレッドと `static`、`volatile` の誤用、TOCTOU（`access` → `open`）、`system()`、`tmpnam`、`gets`、`strtok` の非再入、配列のサイズを `sizeof(ptr)` で取る

## SQL / マイグレーション

- 動的 SQL の連結、`LIKE` のエスケープ、`NULL` の比較（`= NULL` は常に不明）、`NOT IN (subquery with NULL)` が空になる、`JOIN` の重複行で集計が増える、`UPDATE`/`DELETE` の `WHERE` 漏れ、トランザクション分離レベルと read-modify-write、`SELECT ... FOR UPDATE` の欠如、インデックスのない外部キー、`CHECK` 制約の欠落、大きなテーブルのロック、`CASCADE` の意図しない削除、タイムゾーン無しの timestamp、浮動小数点の金額列

## Shell

- 未クォート（`$var`、`$(...)`、`$@` vs `"$@"`）、`rm -rf $DIR/`（空で `/`）、`set -euo pipefail` の有無と罠、`eval`、`cd` 失敗後の続行、一時ファイルの予測可能名、`[ $x = y ]` で x が空、`==` の非 POSIX、ファイル名の空白・改行・`-` 始まり、`curl | sh`、パスワードをコマンドライン引数に（`ps` で見える）

## インフラ / 設定

Dockerfile の root 実行・`latest` タグ・秘密情報の `ENV`/`ARG`、compose/k8s の `privileged`・`hostNetwork`・`hostPath`、CI の `pull_request_target` + PR head の checkout・未ピン留めのアクション。加えて: 環境変数で `DEBUG`/`ENV` を切り替える箇所の既定値、ログレベルの既定、CORS/CSP の既定、シークレットの既定値（空文字で起動できてしまう）。
