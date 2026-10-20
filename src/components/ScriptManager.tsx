import {
  FileCode2,
  Plus,
  RefreshCw,
  Save,
  Play,
  ArrowUp,
  ArrowDown,
  Trash2,
  ListOrdered,
  History,
  Search,
} from "lucide-react";
import { HostTargetPicker } from "./HostTargetPicker";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Input, SearchInput } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Alert, AlertDescription } from "./ui/alert";
import { Choice } from "./Choice";
import { resource, errorMessage, type Host } from "@/lib/api";
interface Script {
  id: string;
  name: string;
  content: string;
  scriptType: string;
  workingDir?: string;
  defaultTimeoutSeconds: number;
}
interface Step {
  name: string;
  scriptId?: string;
  inlineContent?: string;
  scriptType: string;
  workingDir?: string;
  timeoutSeconds: number;
  continueOnError: boolean;
  hostIds?: string[];
}
interface Playbook {
  id: string;
  name: string;
  targetHostIds: string[];
  concurrency: number;
  stopOnFailure: boolean;
}
interface Run {
  id: string;
  name: string;
  status: string;
  errorMessage?: string;
}
interface Detail {
  run: Run;
  steps: {
    step: { id: string; name: string; status: string; errorMessage?: string };
    targets: {
      id: string;
      hostId: string;
      status: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      riskMessage?: string;
    }[];
  }[];
}
const emptyScript = {
  name: "",
  content: "",
  scriptType: "shell",
  workingDir: "",
  defaultTimeoutSeconds: 60,
};
function items<T>(data: T[] | { data: T[] }): T[] {
  return Array.isArray(data) ? data : data.data;
}
export function ScriptManager({ hosts }: { hosts: Host[] }) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("library"),
    [scripts, setScripts] = useState<Script[]>([]),
    [books, setBooks] = useState<Playbook[]>([]),
    [runs, setRuns] = useState<Run[]>([]);
  const [script, setScript] = useState<Omit<Script, "id"> & { id?: string }>(
    emptyScript,
  );
  const [bookId, setBookId] = useState(""),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [steps, setSteps] = useState<Step[]>([]);
  const [concurrency, setConcurrency] = useState(5),
    [stopOnFailure, setStopOnFailure] = useState(true),
    [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let ignore = false;
    void Promise.all([
      resource<{ data: Script[] }>("assets/host-scripts?pageSize=1000"),
      resource<{ data: Playbook[] }>(
        "assets/host-script-playbooks?pageSize=1000",
      ),
      resource<{ data: Run[] }>("assets/host-script-runs?pageSize=100"),
    ])
      .then(([s, b, r]) => {
        if (!ignore) {
          setScripts(items(s));
          setBooks(items(b));
          setRuns(items(r));
        }
      })
      .catch((error) => {
        if (!ignore) setError(errorMessage(error));
      });
    return () => {
      ignore = true;
    };
  }, [revision]);
  const runId = detail?.run.id,
    runStatus = detail?.run.status;
  useEffect(() => {
    if (!runId || !["pending", "queued", "running"].includes(runStatus ?? ""))
      return;
    let ignore = false;
    const timer = setInterval(() => {
      void resource<Detail>(`assets/host-script-runs/${runId}`)
        .then((value) => {
          if (!ignore) setDetail(value);
        })
        .catch((error) => {
          if (!ignore) setError(errorMessage(error));
        });
    }, 1500);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [runId, runStatus]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setRevision((n) => n + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function saveScript() {
    const { id, ...body } = script;
    const saved = await resource<Script>(
      `assets/host-scripts${id ? `/${id}` : ""}`,
      id ? "PUT" : "POST",
      body,
    );
    setScript(saved);
  }
  async function loadBook(id: string) {
    const data = await resource<{
      playbook: Playbook;
      steps: (Step & { targetHostIds: string[] })[];
    }>(`assets/host-script-playbooks/${id}`);
    setBookId(id);
    setName(data.playbook.name);
    setSelected(data.playbook.targetHostIds);
    setConcurrency(data.playbook.concurrency);
    setStopOnFailure(data.playbook.stopOnFailure);
    setSteps(
      data.steps.map((step) => ({ ...step, hostIds: step.targetHostIds })),
    );
    setTab("plan");
  }
  function body() {
    if (!name.trim() || !selected.length || !steps.length)
      throw new Error("请填写名称、选择目标主机并添加步骤");
    if (selected.some((id) => !hosts.some((host) => host.id === id)))
      throw new Error("部分目标已不可访问，请移除不可用目标后执行");
    if (
      steps.some((step) => step.hostIds?.some((id) => !selected.includes(id)))
    )
      throw new Error(
        "部分步骤指定了范围外主机，请改为使用全部目标或补选对应主机",
      );
    return { name, hostIds: selected, steps, concurrency, stopOnFailure };
  }
  async function execute() {
    const data = await resource<Detail>(
      "assets/host-script-runs",
      "POST",
      body(),
    );
    setDetail(data);
    setTab("history");
    await resource(`assets/host-script-runs/${data.run.id}/execute`, "POST");
    setDetail(await resource<Detail>(`assets/host-script-runs/${data.run.id}`));
  }
  const matches = (name: string) =>
    name.toLowerCase().includes(search.toLowerCase());
  const status = (value: string) =>
    ({
      pending: "待执行",
      queued: "排队中",
      running: "执行中",
      completed: "已完成",
      success: "成功",
      failed: "失败",
      cancelled: "已取消",
    })[value] ?? value;
  const addStep = () =>
    setSteps((current) => [
      ...current,
      {
        name: "内联脚本",
        inlineContent: "",
        scriptType: "shell",
        timeoutSeconds: 60,
        continueOnError: false,
      },
    ]);
  const updateStep = (index: number, patch: Partial<Step>) =>
    setSteps((current) =>
      current.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  const moveStep = (index: number, offset: number) =>
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  const newBook = () => {
    setBookId("");
    setName("");
    setSteps([]);
    setSelected([]);
  };
  return (
    <section className="script-workbench" aria-label="主机脚本工作台">
      <header className="script-page-header">
        <div>
          <FileCode2 />
          <div>
            <h1>主机脚本</h1>
            <p>编写、编排与批量执行</p>
          </div>
        </div>
        <span>平台授权 · 执行审计</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新脚本工作台"
          disabled={busy}
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw />
        </Button>
      </header>
      <Tabs
        className="script-workbench-tabs"
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setSearch("");
        }}
      >
        <div className="script-tabbar">
          <TabsList>
            <TabsTrigger value="library">
              <FileCode2 />
              脚本库
            </TabsTrigger>
            <TabsTrigger value="plan">
              <ListOrdered />
              编排与执行
            </TabsTrigger>
            <TabsTrigger value="history">
              <History />
              执行记录
            </TabsTrigger>
          </TabsList>
        </div>
        {error ? (
          <Alert className="script-page-error" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <TabsContent value="library" className="script-page-content">
          <div className="script-library-layout">
            <aside className="script-catalog">
              <div className="script-catalog-top">
                <strong>
                  脚本库 <small>{scripts.length}</small>
                </strong>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="新建脚本"
                  disabled={busy}
                  onClick={() => setScript({ ...emptyScript })}
                >
                  <Plus />
                </Button>
              </div>
              <div className="script-list-search">
                <Search />
                <SearchInput
                  aria-label="搜索脚本"
                  placeholder="搜索脚本…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="script-catalog-list">
                {scripts
                  .filter((item) => matches(item.name))
                  .map((item) => (
                    <button
                      type="button"
                      disabled={busy}
                      key={item.id}
                      data-active={script.id === item.id}
                      onClick={() => setScript(item)}
                    >
                      <FileCode2 />
                      <span>
                        <strong>{item.name}</strong>
                        <small>Shell · {item.defaultTimeoutSeconds}s</small>
                      </span>
                    </button>
                  ))}
                {!scripts.filter((item) => matches(item.name)).length ? (
                  <p className="script-list-empty">
                    {search ? "没有匹配的脚本" : "暂无脚本，先编写一份脚本"}
                  </p>
                ) : null}
              </div>
            </aside>
            <form
              className="script-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void act(saveScript);
              }}
            >
              <div className="script-editor-meta">
                <FieldGroup className="script-metadata-grid">
                  <Field>
                    <FieldLabel>脚本名称</FieldLabel>
                    <Input
                      required
                      aria-label="脚本名称"
                      placeholder="例如：磁盘与服务巡检"
                      value={script.name}
                      onChange={(e) =>
                        setScript({ ...script, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>工作目录</FieldLabel>
                    <Input
                      aria-label="脚本工作目录"
                      placeholder="默认目录"
                      value={script.workingDir ?? ""}
                      onChange={(e) =>
                        setScript({ ...script, workingDir: e.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>超时 / 秒</FieldLabel>
                    <Input
                      aria-label="脚本超时秒"
                      type="number"
                      min={1}
                      max={3600}
                      value={script.defaultTimeoutSeconds}
                      onChange={(e) =>
                        setScript({
                          ...script,
                          defaultTimeoutSeconds: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                </FieldGroup>
              </div>
              <div className="script-code-editor">
                <div>
                  <span>Shell</span>
                  <small>UTF-8 · {script.content.split("\n").length} 行</small>
                </div>
                <Textarea
                  spellCheck={false}
                  wrap="off"
                  className="script-source"
                  required
                  aria-label="脚本内容"
                  placeholder={
                    "#!/usr/bin/env bash\nset -e\n\n# 在这里编写脚本"
                  }
                  value={script.content}
                  onChange={(e) =>
                    setScript({ ...script, content: e.target.value })
                  }
                />
              </div>
              <footer className="script-actionbar">
                <span>{script.id ? "编辑平台脚本" : "新建平台脚本"}</span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !script.content.trim()}
                  onClick={() => {
                    setSteps((current) => [
                      ...current,
                      {
                        name: script.name || "内联脚本",
                        inlineContent: script.content,
                        scriptType: "shell",
                        workingDir: script.workingDir,
                        timeoutSeconds: script.defaultTimeoutSeconds,
                        continueOnError: false,
                      },
                    ]);
                    setTab("plan");
                    setSearch("");
                  }}
                >
                  当前内容加入编排
                </Button>
                <Button disabled={busy} type="submit">
                  <Save />
                  保存脚本
                </Button>
              </footer>
            </form>
          </div>
        </TabsContent>
        <TabsContent value="plan" className="script-page-content">
          <div className="script-plan-layout">
            <aside className="script-catalog">
              <div className="script-catalog-top">
                <strong>
                  已保存编排 <small>{books.length}</small>
                </strong>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="新建编排"
                  disabled={busy}
                  onClick={newBook}
                >
                  <Plus />
                </Button>
              </div>
              <div className="script-list-search">
                <Search />
                <SearchInput
                  aria-label="搜索编排"
                  placeholder="搜索编排…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="script-catalog-list">
                {books
                  .filter((item) => matches(item.name))
                  .map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      disabled={busy}
                      data-active={bookId === item.id}
                      onClick={() => void act(() => loadBook(item.id))}
                    >
                      <ListOrdered />
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.targetHostIds?.length ?? 0} 台主机 · 并发{" "}
                          {item.concurrency}
                        </small>
                      </span>
                    </button>
                  ))}
                {!books.length ? (
                  <p className="script-list-empty">
                    保存常用步骤，下次直接执行
                  </p>
                ) : null}
              </div>
            </aside>
            <div className="script-plan-editor">
              <div className="script-plan-settings">
                <FieldGroup className="script-plan-fields">
                  <Field>
                    <FieldLabel>编排名称</FieldLabel>
                    <Input
                      aria-label="编排名称"
                      placeholder="为本次编排命名"
                      value={name}
                      disabled={busy}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>并发主机数</FieldLabel>
                    <Input
                      aria-label="并发主机数"
                      type="number"
                      min={1}
                      max={50}
                      value={concurrency}
                      disabled={busy}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                    />
                  </Field>
                </FieldGroup>
                <label className="script-check">
                  <input
                    type="checkbox"
                    checked={stopOnFailure}
                    disabled={busy}
                    onChange={(e) => setStopOnFailure(e.target.checked)}
                  />
                  失败时停止后续步骤
                </label>
              </div>
              <div className="script-steps">
                <div className="script-section-label">
                  <strong>执行步骤</strong>
                  <span>{steps.length} 个 · 按顺序执行</span>
                </div>
                {!steps.length ? (
                  <div className="script-plan-empty">
                    <ListOrdered />
                    <strong>添加第一个步骤</strong>
                    <p>选择脚本库中的脚本，或直接编写内联命令。</p>
                  </div>
                ) : null}
                {steps.map((step, index) => (
                  <section className="script-step-card" key={index}>
                    <header>
                      <span className="script-step-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <strong>{step.name}</strong>
                      <div>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`上移步骤 ${index + 1}`}
                          disabled={busy || !index}
                          onClick={() => moveStep(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`下移步骤 ${index + 1}`}
                          disabled={busy || index === steps.length - 1}
                          onClick={() => moveStep(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`移除步骤 ${index + 1}`}
                          disabled={busy}
                          onClick={() =>
                            setSteps((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </header>
                    <div className="script-step-body">
                      <Choice
                        label={`步骤 ${index + 1} 脚本`}
                        disabled={busy}
                        value={step.scriptId || "inline"}
                        options={[
                          { value: "inline", label: "内联脚本" },
                          ...scripts.map((item) => ({
                            value: item.id,
                            label: item.name,
                          })),
                        ]}
                        onChange={(value) =>
                          updateStep(index, {
                            scriptId: value === "inline" ? undefined : value,
                            name:
                              scripts.find((item) => item.id === value)?.name ||
                              "内联脚本",
                          })
                        }
                      />
                      {!step.scriptId ? (
                        <Textarea
                          spellCheck={false}
                          disabled={busy}
                          aria-label={`步骤 ${index + 1} 内容`}
                          placeholder="输入 Shell 脚本…"
                          value={step.inlineContent ?? ""}
                          onChange={(e) =>
                            updateStep(index, { inlineContent: e.target.value })
                          }
                        />
                      ) : null}
                      <div className="script-step-options">
                        <label>
                          超时 / 秒
                          <Input
                            aria-label={`步骤 ${index + 1} 超时秒`}
                            disabled={busy}
                            type="number"
                            min={1}
                            max={3600}
                            value={step.timeoutSeconds}
                            onChange={(e) =>
                              updateStep(index, {
                                timeoutSeconds: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="script-check">
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={step.continueOnError}
                            onChange={(e) =>
                              updateStep(index, {
                                continueOnError: e.target.checked,
                              })
                            }
                          />
                          失败后继续
                        </label>
                      </div>
                      {step.hostIds?.length ? (
                        <div className="script-step-scope">
                          此步骤指定 {step.hostIds.length} 台主机
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => updateStep(index, { hostIds: [] })}
                          >
                            改为全部目标
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </section>
                ))}
                <Button
                  variant="outline"
                  className="script-add-step"
                  disabled={busy}
                  onClick={addStep}
                >
                  <Plus />
                  添加步骤
                </Button>
              </div>
              <footer className="script-actionbar">
                <span>
                  {steps.length} 步骤 · {selected.length} 台目标
                </span>
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    void act(async () => {
                      const result = await resource<{ playbook: Playbook }>(
                        `assets/host-script-playbooks${bookId ? `/${bookId}` : ""}`,
                        bookId ? "PUT" : "POST",
                        body(),
                      );
                      setBookId(result.playbook.id);
                    })
                  }
                >
                  <Save />
                  保存编排
                </Button>
                <Button
                  disabled={busy || !steps.length || !selected.length}
                  onClick={() => void act(execute)}
                >
                  <Play />
                  执行 {steps.length} 个步骤 · {selected.length} 台主机
                </Button>
              </footer>
            </div>
            <HostTargetPicker
              hosts={hosts}
              selected={selected}
              onChange={setSelected}
              disabled={busy}
            />
          </div>
        </TabsContent>
        <TabsContent value="history" className="script-page-content">
          <div className="script-history-layout">
            <aside className="script-catalog">
              <div className="script-catalog-top">
                <strong>
                  执行记录 <small>{runs.length}</small>
                </strong>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="刷新记录"
                  onClick={() => setRevision((n) => n + 1)}
                >
                  <RefreshCw />
                </Button>
              </div>
              <div className="script-list-search">
                <Search />
                <SearchInput
                  aria-label="搜索执行记录"
                  placeholder="搜索记录…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="script-catalog-list">
                {runs
                  .filter((run) => matches(run.name))
                  .map((run) => (
                    <button
                      type="button"
                      key={run.id}
                      disabled={busy}
                      data-active={detail?.run.id === run.id}
                      onClick={() =>
                        void act(async () =>
                          setDetail(
                            await resource<Detail>(
                              `assets/host-script-runs/${run.id}`,
                            ),
                          ),
                        )
                      }
                    >
                      <History />
                      <span>
                        <strong>{run.name}</strong>
                        <small>{status(run.status)}</small>
                      </span>
                    </button>
                  ))}
                {!runs.length ? (
                  <p className="script-list-empty">暂无执行记录</p>
                ) : null}
              </div>
            </aside>
            <div className="script-run-detail">
              {detail ? (
                <>
                  <header>
                    <div>
                      <h2>{detail.run.name}</h2>
                      <p>按步骤查看每台主机的执行结果</p>
                    </div>
                    <span className="script-run-status">
                      {status(detail.run.status)}
                    </span>
                  </header>
                  {detail.run.errorMessage ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {detail.run.errorMessage}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {detail.steps.map(({ step, targets }, index) => (
                    <section className="script-result-step" key={step.id}>
                      <h3>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        {step.name}
                        <small>{status(step.status)}</small>
                      </h3>
                      {step.errorMessage ? <p>{step.errorMessage}</p> : null}
                      {targets.map((target) => (
                        <details key={target.id} open>
                          <summary>
                            <span>
                              {hosts.find((host) => host.id === target.hostId)
                                ?.name || target.hostId}
                            </span>
                            <small>
                              {status(target.status)} · 退出码{" "}
                              {target.exitCode ?? "—"}
                            </small>
                          </summary>
                          <pre className="script-output">
                            {target.stdout}
                            {target.stderr}
                            {target.riskMessage}
                          </pre>
                        </details>
                      ))}
                    </section>
                  ))}
                </>
              ) : (
                <div className="script-plan-empty">
                  <History />
                  <strong>选择一条执行记录</strong>
                  <p>查看执行状态、退出码和完整输出。</p>
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
