# AI配車チューニング

ReqmoのAI配車チューニングは、本番状態を直接変更せず、保存した初期状態と予約列を隔離されたメモリリポジトリで繰り返し再生する。

## 構成

- `src/tuning/scenarioRunner.ts`: 車両・予約・ルートのスナップショットから予約列を再生する
- `src/tuning/evaluator.ts`: ハード制約と運行KPIを評価する
- `src/tuning/parameterSpace.ts`: 自動調整可能な項目、安全範囲、ロックを管理する
- `src/tuning/optimizer.ts`: 再現可能な探索と局所探索を実行する
- `src/tuning/feedbackInterpreter.ts`: 運行担当者の日本語を期待条件へ変換する
- `src/tuning/service.ts`: 実験、推薦、承認、予約適用、ロールバックを管理する
- `packages/web/tuning`: 管理画面

## 安全性

1. 各候補は新しい `InMemoryRepository` で評価され、本番の予約・車両を変更しない。
2. 評価時刻と所要時間行列を固定し、同じシードで同じ結果を再現できる。
3. 定員、営業時間、運行制約、速度・乗降時間は既定でロックされる。
4. 推薦は `DRAFT` で保存され、人の承認なしでは有効にならない。
5. 安全確認用（HOLDOUT）シナリオで悪化した候補は通常承認できない。
6. すべての実行、承認、予約適用、ロールバックを監査ログへ保存する。

## AIの利用

`POST /api/tuning/feedback/interpret` は、担当者の文章を次の評価条件へ変換する。

- `mustAssign`
- `preferredVehicleId`
- `preferredVehicleRequired`
- `maxPickupWaitMinutes`
- `maxExistingPassengerDelayMinutes`
- `maxDesiredTimeDeviationMinutes`
- `dropoffExistingPassengersBeforeNewPickup`
- `maxConsecutivePickups`

Geminiを使う場合は次を設定する。APIキーがない場合は決定的な日本語ルール解析へフォールバックする。

```text
TUNING_LLM_ENABLED=true
TUNING_LLM_MODEL=gemini-3.1-flash-lite
TUNING_LLM_API_KEY=...
```

`TUNING_LLM_API_KEY` が未設定の場合は `GOOGLE_GENAI_API_KEY` を利用する。解析結果は常に管理画面で確認してからシナリオへ反映する。

## API

- `GET /api/tuning/parameter-space`
- `GET|POST /api/tuning/scenario-suites`
- `GET /api/tuning/scenario-suites/:id`
- `GET|POST /api/tuning/runs`
- `GET /api/tuning/runs/:id`
- `GET /api/tuning/recommendations`
- `GET /api/tuning/recommendations/:id`
- `POST /api/tuning/recommendations/:id/approve`
- `POST /api/tuning/rollback`
- `GET /api/tuning/profile-versions`
- `GET /api/tuning/audit-logs`
- `POST /api/tuning/feedback/interpret`

承認APIの `activateAt` に未来のISO日時を指定すると予約適用になる。指定しない場合は即時適用される。通常のリクエスト処理時に期限到来を検出して有効化する。

## 評価方法

ハード制約違反と配車不能を最優先し、その後に待ち時間、希望時刻差、既存乗客遅延、残存ルート時間、希望車両不一致を評価する。配車エンジン内部のスコアではなく、利用者と運行担当者から見た外部KPIを目的関数にする。

シナリオは、設定値を探す「調整用（`TRAIN`）」と、別の予約でも悪化しないことを確かめる「安全確認用（`HOLDOUT`）」に分ける。ここでいう調整用はAIモデル自体の学習ではない。候補はTRAINで改善し、HOLDOUTで制約違反・配車不能が増えず、設定された許容率を超えて悪化しない場合だけ自動的に「安全確認合格」となる。

## 管理画面

ローカルでは次を開く。

```text
http://localhost:18080/tuning/
```

1. 地図上で乗車・降車地点を指定するか、暗号学的乱数によるランダム予約列を生成する
2. 調整用（TRAIN）と安全確認用（HOLDOUT）へ予約を分け、乗車人数・降車先ごとの人数・投入時刻・期待待ち時間を編集する
3. 「現在の設定で配車を確認」を実行し、地図上のルート、車両、乗降順、予定時刻、待ち時間、制約違反を確認する
4. 確認したルートの改善希望をGeminiで解析し、選択中の予約へ期待条件として反映する
5. 人向けの説明を確認しながら、自動調整するパラメータと探索範囲を選ぶ
6. 現在状態とシナリオを保存し、隔離環境で探索を実行する
7. 変更前・候補のKPIと地図上のルートを比較する
8. 即時または日時指定で承認し、必要に応じて過去版へロールバックする

事前確認は `/api/tuning/preview` で行う。現在のリポジトリ状態を隔離コピーへ複製して評価するため、実運行の予約、車両ルート、チューニング履歴は更新しない。予約内容または基準プロファイルを変更すると画面上の確認結果は古い状態になり、AIで条件に変換する前に再確認が必要になる。

配車不能になった予約には、待ち時間、定員、迂回遅延、追加停留所、営業時間・休憩などの除外理由と判定条件、改善候補を表示する。候補プロファイルを即時承認した場合は、画面の事前確認対象も新しい有効プロファイルへ切り替える。日時指定の承認では指定時刻までは現在の有効プロファイルを使う。

「ランダム生成」はクリックごとに新しい生成IDを発行するため、毎回異なる予約列になる。表示中の生成IDで「同じパターンを再現」を選ぶと、比較や再検証のために同じ乗降地点・時刻・人数を再生成できる。生成IDと基準時刻はシナリオセットの `generationMeta` に保存される。

1つの乗車地点から複数の降車先へ分かれる途中降車も扱える。たとえば乗車人数を4人にして「降車先を分ける」を押すと、2人・2人の降車グループが作られ、それぞれ別の停留所を指定できる。乗車人数と降車人数の合計は必ず一致させる。複数の降車グループは同じ車両へ割り当て、「全グループの乗車が最初の途中降車より前に完了する」こともハード制約として検証する。これを満たさず、2人を先に運んでから残り2人を迎えに戻る経路は制約違反になる。ランダム生成にも複数降車のケースが含まれる。
