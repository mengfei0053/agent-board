package tech.mengfei.agentboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskSearchTest {
    private val app = ThinWorkspace("ws_app", "Qt Tools", "/src/QT/app", true)
    private val other = ThinWorkspace("ws_other", "Other", "/tmp/other", false)

    @Test
    fun filterKeepsTitleIdPromptAndPreviewIgnoringCase() {
        val rows = listOf(
            task("task_Title", "Alpha"),
            task("id-hit", "Beta"),
            task("task_p", "Gamma", prompt = "Ship the PATCH"),
            task("task_v", "Delta", promptPreview = "Preview TOKEN"),
            task("task_miss", "Epsilon", prompt = "nothing", promptPreview = "else"),
        )
        assertEquals(listOf("task_Title"), filterTasks("alpha", rows).map { it.id })
        assertEquals(listOf("id-hit"), filterTasks("ID-HIT", rows).map { it.id })
        assertEquals(listOf("task_p"), filterTasks("patch", rows).map { it.id })
        assertEquals(listOf("task_v"), filterTasks("token", rows).map { it.id })
        assertTrue(filterTasks("kanban", rows).isEmpty())
        assertTrue(filterTasks("/src/QT", rows).isEmpty())
        assertEquals(listOf("task_Title"), filterTasks("  AlPhA  ", rows).map { it.id })
    }

    @Test
    fun blankQueryReturnsTheSameList() {
        val rows = listOf(task("a", "Alpha"), task("b", "Beta"))
        assertSame(rows, filterTasks("", rows))
        assertSame(rows, filterTasks("   ", rows))
        assertSame(rows, filterTasks("\n", rows))
    }

    @Test
    fun nullPromptFieldsAreSkipped() {
        val row = task("only", "Title")
        assertTrue(filterTasks("prompt-text", listOf(row)).isEmpty())
        assertEquals(listOf("only"), filterTasks("title", listOf(row)).map { it.id })
    }

    @Test
    fun noWorkspaceHidesCardsEvenWhenRowsAreSupplied() {
        val rows = listOf(
            task("a", "Alpha", prompt = "alpha"),
            task("b", "Beta"),
        )
        val rooms = listOf(app)
        assertTrue(tasksAfterChipAndQuery(rows, rooms, null, TaskChip.ALL, "alpha").isEmpty())
        val shown = renderedHotList(rows, rooms, selectedWorkspaceId = null, chip = TaskChip.ALL, query = "alpha", sawSnapshot = true)
        assertTrue(shown.cards.isEmpty())
        assertEquals(TaskListEmpty.NoWorkspace, shown.empty)
        assertEquals(NO_WORKSPACE_SELECTED_COPY, taskListEmptyCopy(shown.empty))
        val noRooms = renderedHotList(rows, emptyList(), null, TaskChip.ALL, "alpha", sawSnapshot = true)
        assertTrue(noRooms.cards.isEmpty())
        assertEquals(TaskListEmpty.NoWorkspaceBoard, noRooms.empty)
        assertEquals(NO_WORKSPACE_COPY, taskListEmptyCopy(noRooms.empty))
    }

    @Test
    fun pipelineIsWorkspaceThenChipThenQuery() {
        val tasks = listOf(
            task("in", "Find me", workspaceId = "ws_app"),
            task("other", "Find me", workspaceId = "ws_other"),
            task("running", "Find me", status = "running", workspaceId = "ws_app"),
            task("done", "Find me", status = "succeeded", workspaceId = "ws_app"),
        )
        val rooms = listOf(app, other)
        val visible = tasksAfterChipAndQuery(tasks, rooms, "ws_app", TaskChip.DONE, "find")
        assertEquals(listOf("done"), visible.map { it.id })
        val otherRoom = tasksAfterChipAndQuery(tasks, rooms, "ws_other", TaskChip.ALL, "find")
        assertEquals(listOf("other"), otherRoom.map { it.id })
        assertTrue(tasksAfterChipAndQuery(tasks, rooms, "ws_app", TaskChip.ARCHIVE, "find").isEmpty())
    }

    @Test
    fun workspaceChipsIgnoreTheTaskQuery() {
        val items = workspaceSwitchItems(
            listOf(task("u", "Unassigned", workspaceId = null)),
            listOf(app, other),
        )
        assertEquals(items.map { it.id }, workspaceChipsForTaskSearch(items, "zzz").map { it.id })
        assertEquals(items.map { it.id }, workspaceChipsForTaskSearch(items, "Qt").map { it.id })
        assertTrue(filterWorkspaces("zzz", items).isEmpty())
    }

    @Test
    fun emptyCopyPriorityDoesNotCallChipEmptyASearchMiss() {
        val rooms = listOf(app)
        val running = listOf(task("run", "Running", status = "running"))
        val byChip = tasksForChip(visibleTasks(running, rooms, "ws_app"), TaskChip.DONE)
        val matched = filterTasks("running", byChip)
        val chipEmpty = taskListEmpty(
            hot("ws_app", workspaceCount = 1, tasksInWorkspace = running.size, chip = TaskChip.DONE, chipCount = byChip.size, query = "running", matched = matched.size),
        )
        assertEquals(TaskListEmpty.ChipEmpty, chipEmpty)
        assertEquals(FILTER_EMPTY_COPY, taskListEmptyCopy(chipEmpty))
        assertFalse(taskListEmptyCopy(chipEmpty) == NO_TASK_MATCH_COPY)

        val hits = listOf(task("a", "Alpha"), task("b", "Beta"))
        val filtered = filterTasks("nope", hits)
        val miss = taskListEmpty(
            hot("ws_app", 1, hits.size, TaskChip.ALL, hits.size, "nope", filtered.size),
        )
        assertEquals(TaskListEmpty.NoMatch, miss)
        assertEquals(NO_TASK_MATCH_COPY, taskListEmptyCopy(miss))

        val none = taskListEmpty(hot("ws_app", 1, 0, TaskChip.ALL, 0, "alpha", 0))
        assertEquals(TaskListEmpty.NoTasks, none)
        assertEquals(NO_TASKS_COPY, taskListEmptyCopy(none))

        val noSelection = taskListEmpty(
            hot(null, workspaceCount = 1, tasksInWorkspace = 4, chip = TaskChip.ALL, chipCount = 4, query = "alpha", matched = 0),
        )
        assertEquals(TaskListEmpty.NoWorkspace, noSelection)
        assertEquals(NO_WORKSPACE_SELECTED_COPY, taskListEmptyCopy(noSelection))

        val noRooms = taskListEmpty(hot(null, 0, 3, TaskChip.ALL, 3, "alpha", 0))
        assertEquals(TaskListEmpty.NoWorkspaceBoard, noRooms)
        assertEquals(NO_WORKSPACE_COPY, taskListEmptyCopy(noRooms))

        assertEquals(TaskListEmpty.Loading, taskListEmpty(hot("ws_app", 1, 0, TaskChip.ALL, 0, "alpha", 0, saw = false)))
        assertNull(taskListEmptyCopy(TaskListEmpty.None))
    }

    @Test
    fun queryDoesNotResurrectAnotherBoard() {
        val foreign = listOf(task("secret", "Find me"))
        val painted = tasksAfterSessionSwitch("board-a", "board-b", foreign)
        assertTrue(painted.isEmpty())
        val visible = tasksAfterChipAndQuery(painted, listOf(app), "ws_app", TaskChip.ALL, "find")
        assertTrue(visible.isEmpty())
        val kind = taskListEmpty(hot("ws_app", 1, visible.size, TaskChip.ALL, visible.size, "find", visible.size))
        assertEquals(TaskListEmpty.NoTasks, kind)
        assertEquals(NO_TASK_MATCH_COPY, taskListEmptyCopy(TaskListEmpty.NoMatch))
        assertFalse(taskListEmptyCopy(kind)!!.contains("无匹配任务"))
    }

    @Test
    fun archiveSearchUsesOnlyRowsConfirmedForTheActiveBoardAndWorkspace() {
        val page = listOf(
            task("arch", "Old title", status = ARCHIVED_STATUS, prompt = "ship it", promptPreview = "preview"),
            task("other-arch", "Old title", status = ARCHIVED_STATUS, workspaceId = "ws_other"),
        )
        val scoped = page.filter { it.workspaceId == "ws_app" }
        val confirmed = confirmedArchiveTasks(
            ArchiveLoadScope(scoped, loaded = true, sessionId = "sA", workspaceId = "ws_app", activeSessionId = "sA", selectedWorkspaceId = "ws_app"),
        )
        assertEquals(listOf("arch"), confirmed?.map { it.id })
        assertEquals(listOf("arch"), archiveRowsForQuery(confirmed, "SHIP").map { it.id })
        assertEquals(listOf("arch"), archiveRowsForQuery(confirmed, "preview").map { it.id })
        assertTrue(archiveRowsForQuery(confirmed, "nope").isEmpty())

        assertNull(
            confirmedArchiveTasks(
                ArchiveLoadScope(page, true, "sA", "ws_app", "sA", "ws_app"),
            ),
        )
        assertNull(
            confirmedArchiveTasks(
                ArchiveLoadScope(scoped, true, "sA", "ws_app", "sB", "ws_app"),
            ),
        )
        assertNull(
            confirmedArchiveTasks(
                ArchiveLoadScope(scoped, true, "sA", "ws_app", "sA", "ws_other"),
            ),
        )
        assertNull(
            confirmedArchiveTasks(
                ArchiveLoadScope(scoped, loaded = false, sessionId = "sA", workspaceId = "ws_app", activeSessionId = "sA", selectedWorkspaceId = "ws_app"),
            ),
        )

        val loadedMiss = taskListEmpty(
            archiveQuery(loaded = true, loadedCount = 1, matched = 0, query = "nope"),
        )
        assertEquals(TaskListEmpty.ArchiveNoMatch, loadedMiss)
        assertEquals(ARCHIVE_NO_MATCH_COPY, taskListEmptyCopy(loadedMiss))
        assertFalse(taskListEmptyCopy(loadedMiss) == NO_TASK_MATCH_COPY)

        val unsupported = taskListEmpty(
            archiveQuery(scopeUnsupported = true, query = "nope", error = ARCHIVE_SCOPE_UNSUPPORTED),
        )
        assertEquals(TaskListEmpty.ArchiveUnsupported, unsupported)
        assertEquals(ARCHIVE_SCOPE_UNSUPPORTED, taskListEmptyCopy(unsupported, archiveError = ARCHIVE_SCOPE_UNSUPPORTED))

        val capability = taskListEmpty(archiveQuery(supported = false, query = "nope"))
        assertEquals(TaskListEmpty.ArchiveUnsupported, capability)
        assertEquals(ARCHIVE_UNAVAILABLE_COPY, taskListEmptyCopy(capability))

        val loading = taskListEmpty(archiveQuery(busy = true, query = "nope"))
        assertEquals(TaskListEmpty.ArchiveLoading, loading)
        assertEquals(ARCHIVE_LOADING_COPY, taskListEmptyCopy(loading))

        val failed = taskListEmpty(archiveQuery(error = "Could not load the archive.", query = "nope"))
        assertEquals(TaskListEmpty.ArchiveFailed, failed)
        assertEquals("Could not load the archive.", taskListEmptyCopy(failed, archiveError = "Could not load the archive."))

        val unloaded = taskListEmpty(archiveQuery(query = "nope"))
        assertEquals(TaskListEmpty.ArchiveUnloaded, unloaded)
        assertEquals(ARCHIVE_UNLOADED_COPY, taskListEmptyCopy(unloaded))

        val emptyPage = taskListEmpty(archiveQuery(loaded = true, loadedCount = 0, matched = 0, query = "nope"))
        assertEquals(TaskListEmpty.ArchiveEmpty, emptyPage)
        assertEquals(ARCHIVE_EMPTY_COPY, taskListEmptyCopy(emptyPage))

        val noWorkspace = taskListEmpty(
            archiveQuery(selected = null, workspaceCount = 2, loaded = true, loadedCount = 3, matched = 0, query = "nope"),
        )
        assertEquals(TaskListEmpty.NoWorkspace, noWorkspace)
    }

    @Test
    fun lateArchiveReplyDoesNotReplaceThePendingRequest() {
        val rows = listOf(task("arch", "Old", status = ARCHIVED_STATUS))
        assertFalse(acceptArchivePage("req-new", "req-old", rows, "ws_app"))
        assertFalse(acceptArchivePage("req-new", null, rows, "ws_app"))
        assertFalse(acceptArchivePage(null, "req-new", rows, "ws_app"))
        assertFalse(acceptArchivePage("req-new", "req-new", listOf(task("x", "X", status = ARCHIVED_STATUS, workspaceId = "ws_other")), "ws_app"))
        assertTrue(acceptArchivePage("req-new", "req-new", rows, "ws_app"))
        assertTrue(archiveReplyMatches("req-new", "req-new"))
    }

    @Test
    fun searchAndWorkspaceSwitchKeepTheChipAndClearOnWorkspaceChange() {
        val chip = TaskChip.DONE
        val edited = withTaskQuery(chrome(chip), "alpha")
        assertEquals(chip, edited.chip)
        assertEquals("alpha", edited.search)
        val cleared = selectWorkspaceChrome(edited)
        assertEquals("", cleared.search)
        assertEquals(chip, cleared.chip)
        assertNull(cleared.detailTaskId)
    }

    @Test
    fun bothBoardPicksRestoreAValidWorkspaceAndClearQuery() {
        val rooms = listOf(app, other)
        val tasks = listOf(
            task("a", "A", workspaceId = "ws_app"),
            task("b", "B", workspaceId = "ws_other"),
        )
        val chrome = chrome(TaskChip.RUNNING).copy(search = "qt", detailTaskId = "task", continuePrompt = "stay", continueOpen = true, screen = "detail")
        val switcher = pickBoard(BoardPickPath.TopSwitcher, chrome, session("sB", "board-b"), "missing", rooms, tasks, sawSnapshot = true)
        val boards = pickBoard(BoardPickPath.MyBoards, chrome, session("sB", "board-b"), "missing", rooms, tasks, sawSnapshot = true)
        assertEquals(switcher.chrome, boards.chrome)
        assertEquals(switcher.workspaceId, boards.workspaceId)
        assertEquals("sB", switcher.chrome.sessionId)
        assertEquals("", switcher.chrome.search)
        assertNull(switcher.chrome.detailTaskId)
        assertEquals("", switcher.chrome.continuePrompt)
        assertFalse(switcher.chrome.continueOpen)
        assertEquals(TaskChip.RUNNING, switcher.chrome.chip)
        assertEquals("tasks", switcher.chrome.screen)
        assertEquals("ws_app", switcher.workspaceId)
        val remembered = pickBoard(BoardPickPath.TopSwitcher, chrome, session("sB", "board-b"), "ws_other", rooms, tasks, true)
        assertEquals("ws_other", remembered.workspaceId)
        val none = pickBoard(BoardPickPath.MyBoards, chrome, session("sB", "board-b"), null, emptyList(), emptyList(), true)
        assertNull(none.workspaceId)
    }

    @Test
    fun forgetLandingAndMemoryKeepTheOtherBoard() {
        assertEquals(ForgetDestination.TaskList, forgetDestination(allowed = true, forgotActive = true, rolledBack = false))
        assertEquals(ForgetDestination.MyBoards, forgetDestination(allowed = true, forgotActive = false, rolledBack = false))
        assertEquals(ForgetDestination.Unchanged, forgetDestination(allowed = false, forgotActive = true, rolledBack = false))
        assertEquals(ForgetDestination.Unchanged, forgetDestination(allowed = true, forgotActive = true, rolledBack = true))
        val before = ForgetMemory(
            slotSessionIds = setOf("sA", "sB"),
            refSessionIds = setOf("sA", "sB"),
            logs = listOf(LiveLog("cA", "board-a"), LiveLog("cB", "board-b")),
        )
        val after = forgetMemoryEffect(before, "sA", "cA", "board-a")
        assertEquals(setOf("sB"), after.slotSessionIds)
        assertEquals(setOf("sB"), after.refSessionIds)
        assertEquals(listOf(LiveLog("cB", "board-b")), after.logs)
    }

    @Test
    fun sessionHintIsNotATokenPrefix() {
        assertEquals("本机会话已保存", SESSION_SAVED_COPY)
        assertFalse(SESSION_SAVED_COPY.contains("pc_"))
        assertFalse(SESSION_SAVED_COPY.contains("dt_"))
        assertFalse(SESSION_SAVED_COPY.contains("token"))
        val subtitle = cardSubtitle("https://relay.example", "board-a")
        assertEquals("relay.example · board-a", subtitle)
        assertFalse(subtitle.contains("dt_"))
    }

    @Test
    fun pairFailureAndStaleCompletionDoNotMoveTheSelection() {
        assertEquals(PairApply.KeepSelection, pairResultApply(requestEpoch = 1, currentEpoch = 1, succeeded = false))
        assertEquals(PairApply.KeepSelection, pairResultApply(requestEpoch = 1, currentEpoch = 2, succeeded = true))
        assertEquals(PairApply.Land, pairResultApply(requestEpoch = 4, currentEpoch = 4, succeeded = true))
    }

    @Test
    fun deferredPairSuccessAfterBackDoesNotSwitchOrToast() {
        val attempt = PairContext(epoch = 4, activeSessionId = "sA")
        val afterBack = pairContextAfterDeparture(attempt, PairDeparture.Back)
        assertFalse(pairAttemptStillCurrent(attempt, afterBack))
        val effect = deferredPairSuccess(attempt, afterBack, proposedActiveId = "sNew")
        assertFalse(effect.applyTransaction)
        assertEquals("sA", effect.activeSessionId)
        assertFalse(effect.successToast)
    }

    @Test
    fun deferredPairSuccessAfterBoardSelectionDoesNotSwitchOrToast() {
        val attempt = PairContext(epoch = 2, activeSessionId = "sA")
        val departed = pairContextAfterDeparture(attempt, PairDeparture.BoardSwitch)
        val afterSelection = departed.copy(activeSessionId = "sB")
        val effect = deferredPairSuccess(attempt, afterSelection, proposedActiveId = "sNew")
        assertFalse(effect.applyTransaction)
        assertEquals("sB", effect.activeSessionId)
        assertFalse(effect.successToast)
        val stillHere = deferredPairSuccess(attempt, attempt, proposedActiveId = "sNew")
        assertTrue(stillHere.applyTransaction)
        assertEquals("sNew", stillHere.activeSessionId)
        assertTrue(stillHere.successToast)
    }

    private fun hot(
        selected: String?,
        workspaceCount: Int,
        tasksInWorkspace: Int,
        chip: TaskChip,
        chipCount: Int,
        query: String,
        matched: Int,
        saw: Boolean = true,
    ) = TaskListQuery(
        sawSnapshot = saw,
        selectedWorkspaceId = selected,
        workspaceCount = workspaceCount,
        tasksInWorkspace = tasksInWorkspace,
        chip = chip,
        chipCount = chipCount,
        query = query,
        matchedCount = matched,
    )

    private fun archiveQuery(
        selected: String? = "ws_app",
        workspaceCount: Int = 1,
        supported: Boolean = true,
        scopeUnsupported: Boolean = false,
        busy: Boolean = false,
        loaded: Boolean = false,
        loadedCount: Int = 0,
        matched: Int = 0,
        query: String = "",
        error: String? = null,
        saw: Boolean = true,
    ) = TaskListQuery(
        sawSnapshot = saw,
        selectedWorkspaceId = selected,
        workspaceCount = workspaceCount,
        tasksInWorkspace = 0,
        chip = TaskChip.ARCHIVE,
        chipCount = 0,
        query = query,
        matchedCount = matched,
        archiveSupported = supported,
        archiveScopeUnsupported = scopeUnsupported,
        archiveBusy = busy,
        archiveLoadedInScope = loaded,
        archiveLoadedCount = loadedCount,
        archiveError = error,
    )

    private fun task(
        id: String,
        title: String,
        status: String = "queued",
        workspaceId: String? = "ws_app",
        prompt: String? = null,
        promptPreview: String? = null,
    ) = RelayTask(
        id = id,
        title = title,
        status = status,
        updatedAt = 1,
        workspaceId = workspaceId,
        prompt = prompt,
        promptPreview = promptPreview,
    )

    private fun chrome(chip: TaskChip) = ListChrome("sA", chip, "", null, "", false, "tasks", null)

    private fun session(id: String, boardId: String) = PhoneSession(id, "c1", boardId, boardId, 1)
}
