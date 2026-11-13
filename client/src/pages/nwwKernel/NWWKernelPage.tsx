import { useState, useEffect } from "react";
import {
  getNWWHealth,
  getNWWShelf,
  createNWWBook,
  bootstrapNWWBook,
  getNWWChapters,
  buildNWVPacket,
  runNWWWrite,
  type NWWHealth,
  type NWWBook,
  type NWWChapter,
} from "@/api/nwwKernel";

export default function NWWKernelPage() {
  const [health, setHealth] = useState<NWWHealth | null>(null);
  const [books, setBooks] = useState<NWWBook[]>([]);
  const [projectsRoot, setProjectsRoot] = useState<string | null>(null);
  const [selectedBook, setSelectedBook] = useState<NWWBook | null>(null);
  const [chapters, setChapters] = useState<NWWChapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [bookTitle, setBookTitle] = useState("");
  const [action, setAction] = useState<string>("");
  const [actionResult, setActionResult] = useState<string>("");

  async function loadData() {
    try {
      const h = await getNWWHealth();
      setHealth(h);
      if (h.ok) {
        const shelf = await getNWWShelf();
        setBooks(shelf.books || []);
        setProjectsRoot(shelf.projects_root ?? null);
      }
    } catch (err) {
      console.error("NWW kernel load error:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function selectBook(book: NWWBook) {
    setSelectedBook(book);
    setActionResult("");
    try {
      const res = await getNWWChapters(book.id);
      setChapters(res.chapters || []);
    } catch (err) {
      console.error("Failed to load chapters:", err);
      setChapters([]);
    }
  }

  async function handleCreateBook() {
    if (!bookTitle.trim()) return;
    setCreating(true);
    try {
      const book = await createNWWBook({ title: bookTitle.trim() });
      setBookTitle("");
      await loadData();
      selectBook(book);
    } catch (err) {
      console.error("Create book failed:", err);
      alert("创建失败: " + (err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleBootstrap() {
    if (!selectedBook) return;
    setAction("bootstrap");
    setActionResult("");
    try {
      const res = await bootstrapNWWBook(selectedBook.id);
      setActionResult(`✓ bootstrap 完成: 写入 ${res.written?.length || 0} 个文件, 跳过 ${res.skipped?.length || 0} 个`);
    } catch (err) {
      setActionResult(`✗ bootstrap 失败: ${(err as Error).message}`);
    } finally {
      setAction("");
    }
  }

  async function handlePacket() {
    if (!selectedBook) return;
    setAction("packet");
    setActionResult("");
    try {
      await buildNWVPacket(selectedBook.id, selectedChapter);
      setActionResult(`✓ 第 ${selectedChapter} 章 Packet 构建完成`);
    } catch (err) {
      setActionResult(`✗ Packet 构建失败: ${(err as Error).message}`);
    } finally {
      setAction("");
    }
  }

  async function handleWrite() {
    if (!selectedBook) return;
    setAction("write");
    setActionResult("");
    try {
      const res = await runNWWWrite(selectedBook.id, selectedChapter);
      if (res.ok) {
        setActionResult(`✓ 第 ${selectedChapter} 章写作完成!`);
      } else {
        setActionResult(`✗ 写作失败: ${res.error || "未知错误"}`);
      }
    } catch (err) {
      setActionResult(`✗ 写作失败: ${(err as Error).message}`);
    } finally {
      setAction("");
    }
  }

  if (loading) {
    return <div className="p-6">加载中...</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">NWW-V12 内核工作台</h1>

      {/* 健康状态 */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex items-center gap-4">
          <span
            className={`inline-block w-3 h-3 rounded-full ${
              health?.ok ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <span className="text-gray-700">
            {health?.ok ? "内核运行中" : "内核不可达"}
          </span>
          <span className="text-sm text-gray-500 font-mono ml-auto">
            {health?.service || "nww-kernel（V14 独立副本）"} v{health?.version || "12.x"}
          </span>
        </div>
        <div className="mt-2 text-xs text-gray-500 font-mono">
          数据根：{projectsRoot ?? "未返回 projects_root"}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* 左列：书架 + 建书 */}
        <div className="col-span-1 space-y-4">
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-semibold mb-3">内核书架</h2>
            {books.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无书稿</p>
            ) : (
              <ul className="space-y-1">
                {books.map((book) => (
                  <li key={book.id}>
                    <button
                      onClick={() => selectBook(book)}
                      className={`w-full text-left p-2 rounded text-sm hover:bg-gray-100 ${
                        selectedBook?.id === book.id ? "bg-blue-50 border border-blue-200" : ""
                      }`}
                    >
                      {book.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-semibold mb-3">新建书稿</h2>
            <input
              type="text"
              value={bookTitle}
              onChange={(e) => setBookTitle(e.target.value)}
              placeholder="输入书名..."
              className="w-full border rounded px-3 py-2 text-sm mb-2"
              onKeyDown={(e) => e.key === "Enter" && handleCreateBook()}
            />
            <button
              onClick={handleCreateBook}
              disabled={creating || !bookTitle.trim()}
              className="w-full bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
            >
              {creating ? "创建中..." : "创建"}
            </button>
          </div>
        </div>

        {/* 右列：选中书的操作 */}
        <div className="col-span-2">
          {selectedBook ? (
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold mb-1">{selectedBook.title}</h2>
              <p className="text-sm text-gray-500 font-mono mb-4">ID: {selectedBook.id}</p>

              {/* 操作按钮 */}
              <div className="flex gap-2 mb-4 flex-wrap">
                <button
                  onClick={handleBootstrap}
                  disabled={!!action}
                  className="bg-purple-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
                >
                  {action === "bootstrap" ? "生成中..." : "📦 Bootstrap 立项"}
                </button>
                <button
                  onClick={handlePacket}
                  disabled={!!action}
                  className="bg-orange-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
                >
                  {action === "packet" ? "打包中..." : "📋 构建 Packet"}
                </button>
                <button
                  onClick={handleWrite}
                  disabled={!!action}
                  className="bg-green-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
                >
                  {action === "write" ? "写作中..." : "✍️ 写正文"}
                </button>
              </div>

              {/* 章节选择 */}
              <div className="mb-4">
                <label className="text-sm text-gray-600 block mb-1">章节号:</label>
                <input
                  type="number"
                  min={1}
                  value={selectedChapter}
                  onChange={(e) => setSelectedChapter(parseInt(e.target.value) || 1)}
                  className="border rounded px-3 py-2 text-sm w-24"
                />
              </div>

              {/* 已有章节列表 */}
              {chapters.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold mb-2 text-gray-700">已有章节</h3>
                  <div className="flex flex-wrap gap-1">
                    {chapters.map((ch) => (
                      <button
                        key={ch.no}
                        onClick={() => setSelectedChapter(ch.no)}
                        className={`px-2 py-1 text-xs rounded border ${
                          selectedChapter === ch.no
                            ? "bg-blue-100 border-blue-400"
                            : "bg-gray-50 border-gray-200"
                        }`}
                      >
                        第{ch.no}章
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 操作结果 */}
              {actionResult && (
                <div className="mt-4 p-3 bg-gray-50 rounded text-sm font-mono whitespace-pre-wrap">
                  {actionResult}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow p-8 text-center text-gray-400">
              <p className="mb-2">从左侧选择一本书，或新建一本开始创作</p>
              <p className="text-sm">内核提供：立项 Bootstrap → 上下文 Packet 构建 → 多 Agent 写正文 → 质量门禁 全流程</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
