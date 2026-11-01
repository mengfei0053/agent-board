package tech.mengfei.agentboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCatalogTest {
    private val origin = "https://relay.example"

    @Test
    fun catalogRoundTripKeepsOrderBindingsAndActiveId() {
        val document = catalog(listOf(session("sA", "c1", "board-a"), session("sB", "c1", "board-b")), "sB")
        val decoded = decodeCatalog(encodeCatalog(document))
        assertEquals(document, decoded)
    }

    @Test
    fun unreadableSecretsDoNotRenderPlainRows() {
        val disk = sharedDisk().copy(secretsReadable = false)
        val launch = recoverLaunch(disk)
        assertEquals(LaunchPhase.UNPAIRED, launch.phase)
        assertTrue(launch.sessions.isEmpty())
        assertEquals(SECURE_STORAGE_BANNER, launch.banner)
        assertNull(launch.readingCopy)
    }

    @Test
    fun repairCrashBeforeCatalogKeepsActiveIdAndOldSocket() {
        val start = sharedDisk()
        val request = repairRequest("sA", listOf("board-a"))
        val proceed = planPair(start, request) as PairOutcome.Proceed
        val crashed = simulate(start, setOf("c1"), proceed.tx, failAt = 1)
        assertFalse(crashed.cutover)
        assertEquals("sA", crashed.activeSessionId)
        assertEquals(setOf("c1"), crashed.openSockets)
        assertEquals("c1", crashed.disk.catalog!!.session("sA")!!.credentialId)
        assertNull(crashed.disk.credentials["c2"])
        assertNotNull(crashed.disk.credentials["c1"])
        val restarted = recoverLaunch(crashed.disk)
        assertEquals("sA", restarted.activeSessionId)
        assertEquals("c1", restarted.sessions.first { it.sessionId == "sA" }.credentialId)
    }

    @Test
    fun repairCrashAfterCatalogDropsOnlyUnreferencedSecrets() {
        val start = oneBoardDisk()
        val proceed = planPair(start, repairRequest("sA", listOf("board-a"), credentialId = "c2")) as PairOutcome.Proceed
        val crashed = simulate(start, setOf("c1"), proceed.tx, failAt = 2)
        assertTrue(crashed.cutover)
        assertEquals("c2", crashed.disk.catalog!!.session("sA")!!.credentialId)
        assertNotNull(crashed.disk.credentials["c1"])
        val cleaned = applyOps(crashed.disk, recoverLaunch(crashed.disk).cleanup)
        assertNull(cleaned.credentials["c1"])
        assertNotNull(cleaned.credentials["c2"])
        assertEquals(setOf("c1").filter { it in referencedCredentialIds(crashed.disk) }.toSet(), crashed.openSockets)
    }

    @Test
    fun sharedRepairDoesNotDeleteTheCredentialTheOtherSessionUses() {
        val start = sharedDisk()
        val proceed = planPair(start, repairRequest("sA", listOf("board-a"))) as PairOutcome.Proceed
        for (failAt in listOf<Int?>(0, 1, null)) {
            val result = simulate(start, setOf("c1"), proceed.tx, failAt = failAt)
            assertNotNull(result.disk.credentials["c1"])
            assertEquals(setOf("c1"), result.openSockets)
            if (failAt == null) {
                assertEquals("c2", result.disk.catalog!!.session("sA")!!.credentialId)
                assertEquals("c1", result.disk.catalog!!.session("sB")!!.credentialId)
                assertEquals(2, result.disk.catalog!!.sessions.size)
            } else {
                assertEquals("c1", result.disk.catalog!!.session("sA")!!.credentialId)
            }
        }
        val restarted = applyOps(
            simulate(start, setOf("c1"), proceed.tx, failAt = 1).disk,
            recoverLaunch(simulate(start, setOf("c1"), proceed.tx, failAt = 1).disk).cleanup,
        )
        assertNotNull(restarted.credentials["c1"])
        assertNull(restarted.credentials["c2"])
    }

    @Test
    fun sharedForgetCrashPointsKeepTheRemainingSecret() {
        val start = sharedDisk()
        val forget = planForget(start, "sA")
        assertTrue(forget.allowed)
        val tx = forget.tx!!
        val before = simulate(start, setOf("c1"), tx, failAt = 0)
        assertEquals("sA", before.activeSessionId)
        assertEquals(setOf("sA", "sB"), before.disk.catalog!!.order.toSet())
        assertEquals(setOf("c1"), before.openSockets)
        val afterCatalog = simulate(start, setOf("c1"), tx, failAt = 1)
        assertEquals("sB", afterCatalog.activeSessionId)
        assertFalse(afterCatalog.disk.catalog!!.order.contains("sA"))
        assertNotNull(afterCatalog.disk.credentials["c1"])
        assertEquals("home", afterCatalog.disk.workspaces["sA"])
        val cleaned = applyOps(afterCatalog.disk, recoverLaunch(afterCatalog.disk).cleanup)
        assertNull(cleaned.workspaces["sA"])
        assertNull(cleaned.drafts["sA"])
        assertNull(cleaned.archiveCursors["sA"])
        assertNotNull(cleaned.credentials["c1"])
        val done = simulate(start, setOf("c1"), tx)
        assertNull(done.disk.workspaces["sA"])
        assertEquals(setOf("c1"), done.openSockets)
        assertFalse(planForget(done.disk, "sB").allowed)
    }

    @Test
    fun migrationCrashPointsDoNotDropTheLegacyTokenEarly() {
        val legacy = legacyDisk(mapOf("board-a" to "ws_app"))
        val startTx = planMigrationStart(legacy, "c1")!!
        val secretFailed = simulate(legacy, emptySet(), startTx, failAt = 0)
        assertNull(secretFailed.disk.catalog)
        assertNotNull(secretFailed.disk.legacy)
        assertEquals(LaunchPhase.MIGRATING, recoverLaunch(secretFailed.disk).phase)
        val catalogFailed = simulate(legacy, emptySet(), startTx, failAt = 1)
        assertNull(catalogFailed.disk.catalog)
        assertNotNull(catalogFailed.disk.legacy)
        val pending = simulate(legacy, emptySet(), startTx)
        assertEquals(MigrationState.PENDING, pending.disk.catalog!!.migrationState)
        assertTrue(pending.disk.catalog!!.sessions.isEmpty())
        assertNull(pending.activeSessionId)
        assertNotNull(pending.disk.legacy)
        val launch = recoverLaunch(pending.disk)
        assertEquals(MIGRATION_READING, launch.readingCopy)
        assertTrue(launch.sessions.isEmpty())
        assertEquals(LaunchPhase.MIGRATING, launch.phase)
    }

    @Test
    fun nineteenPlusTwoNewIdsInsertsNothingAndConsumesTheCode() {
        val start = manyDisk(19)
        val outcome = planPair(start, addRequest(listOf("new-a", "new-b"), ids = listOf("n1", "n2")))
        val reject = outcome as PairOutcome.Reject
        assertTrue(reject.consumedCode)
        assertEquals(CODE_CONSUMED_NO_ROOM, reject.message)
        assertFalse(reject.message.contains("pc_"))
        assertFalse(reject.message.contains("dt_"))
        val erased = simulate(start, setOf("c0"), reject.rollback!!, failAt = null)
        assertEquals(19, erased.disk.catalog!!.sessions.size)
        assertNull(erased.disk.credentials["c-new"])
        assertEquals("s0", erased.activeSessionId)
        assertEquals(setOf("c0"), erased.openSockets)
        val stranded = simulate(start, setOf("c0"), reject.rollback, failAt = 1, rollbackCommitFails = true)
        assertNotNull(stranded.disk.credentials["c-new"])
        val swept = applyOps(stranded.disk, recoverLaunch(stranded.disk).cleanup)
        assertNull(swept.credentials["c-new"])
        assertEquals(19, swept.catalog!!.sessions.size)
    }

    @Test
    fun twentyCommittedWithOneUnreadableDoesNotPostAGeneralAdd() {
        val sessions = (0 until 20).map { index ->
            session("s$index", if (index == 19) "c-missing" else "c0", "board-$index")
        }
        val disk = PhoneDisk(
            credentials = mapOf("c0" to secret("c0", "dt_old", (0 until 19).map { "board-$it" })),
            catalog = catalog(sessions, "s0"),
        )
        assertEquals(20, committedSessionCount(disk))
        assertEquals(19, readableSessions(disk).size)
        assertTrue(pairPrecheck(committedSessionCount(disk), repair = false) is PairPrecheck.Refuse)
        assertTrue(pairPrecheck(readableSessions(disk).size, repair = false) is PairPrecheck.Post)
        assertTrue(pairPrecheck(committedSessionCount(disk), repair = true) is PairPrecheck.Post)
    }

    @Test
    fun generalAddAtCapDoesNotPostAndRepairOfTheTargetIsAllowed() {
        val start = manyDisk(20)
        assertTrue(pairPrecheck(20, repair = false) is PairPrecheck.Refuse)
        assertTrue(pairPrecheck(20, repair = true) is PairPrecheck.Post)
        val repair = planPair(start, repairRequest("s0", listOf("board-0"), credentialId = "c-new")) as PairOutcome.Proceed
        val done = simulate(start, setOf("c0"), repair.tx)
        assertEquals(20, done.disk.catalog!!.sessions.size)
        assertEquals("c-new", done.disk.catalog!!.session("s0")!!.credentialId)
        val mixed = planPair(
            start,
            repairRequest("s0", listOf("board-0", "board-extra"), credentialId = "c-new"),
        ) as PairOutcome.Reject
        assertTrue(mixed.consumedCode)
        assertEquals(CODE_CONSUMED_REPAIR, mixed.message)
        val kept = simulate(start, setOf("c0"), mixed.rollback!!)
        assertEquals("c0", kept.disk.catalog!!.session("s0")!!.credentialId)
        assertEquals(20, kept.disk.catalog!!.sessions.size)
    }

    @Test
    fun mixedOldAndNewThatDoesNotFitIsRejectedWhole() {
        val start = manyDisk(19)
        val outcome = planPair(
            start,
            addRequest(listOf("board-0", "new-a", "new-b"), ids = listOf("n1", "n2")),
        ) as PairOutcome.Reject
        assertEquals(CODE_CONSUMED_NO_ROOM, outcome.message)
        val disk = simulate(start, setOf("c0"), outcome.rollback!!).disk
        assertEquals("c0", disk.catalog!!.session("s0")!!.credentialId)
        assertEquals(19, disk.catalog!!.sessions.size)
        assertTrue(disk.catalog!!.sessions.none { it.boardId == "new-a" })
    }

    @Test
    fun oneResponseWithTwoBoardsStoresOneSecretAndTwoSessions() {
        val done = simulate(PhoneDisk(), emptySet(), (planPair(PhoneDisk(), addRequest(listOf("board-a", "board-b"), ids = listOf("sA", "sB"))) as PairOutcome.Proceed).tx)
        assertEquals(listOf("sA", "sB"), done.disk.catalog!!.order)
        assertEquals("sA", done.activeSessionId)
        assertEquals(1, done.disk.credentials.size)
        assertEquals(listOf("board-a", "board-b"), done.disk.credentials.values.single().boardIds)
    }

    @Test
    fun refreshKeepsSessionIdAndFailedSecretCommitDoesNotCloseOtherSockets() {
        val start = sharedDisk()
        val tx = planRefresh(start, "c1", pair("dt_next", listOf("board-a", "board-b")))!!
        val failed = simulate(start, setOf("c1", "c-other"), tx, failAt = 0)
        assertEquals("dt_old", failed.disk.credentials["c1"]!!.deviceToken)
        assertEquals(setOf("c1", "c-other"), failed.openSockets)
        assertEquals("sA", failed.disk.catalog!!.session("sA")!!.sessionId)
        val ok = simulate(start, setOf("c1", "c-other"), tx)
        assertEquals("dt_next", ok.disk.credentials["c1"]!!.deviceToken)
        assertEquals("sA", ok.disk.catalog!!.session("sA")!!.sessionId)
        assertEquals(setOf("c1", "c-other"), ok.openSockets)
    }

    @Test
    fun sameBoardIdOnAnotherOriginDoesNotShareWorkspace() {
        val first = simulate(PhoneDisk(), emptySet(), (planPair(PhoneDisk(), addRequest(listOf("board-a"), ids = listOf("s1"), credentialId = "c1")) as PairOutcome.Proceed).tx).disk
        val withWorkspace = first.copy(workspaces = mapOf("s1" to "ws_app"))
        val second = planPair(
            withWorkspace,
            addRequest(listOf("board-a"), ids = listOf("s2"), credentialId = "c2", httpBase = "https://other.example"),
        ) as PairOutcome.Proceed
        val done = simulate(withWorkspace, setOf("c1"), second.tx)
        assertEquals(2, done.disk.catalog!!.sessions.size)
        assertEquals("ws_app", done.disk.workspaces["s1"])
        assertNull(done.disk.workspaces["s2"])
        assertEquals(setOf("c1"), done.openSockets)
    }

    @Test
    fun offlineMigrationStaysOnTheReadingCopyAcrossRestart() {
        val pending = simulate(legacyDisk(emptyMap()), emptySet(), planMigrationStart(legacyDisk(emptyMap()), "c1")!!).disk
        val launch = recoverLaunch(pending)
        assertEquals(MIGRATION_READING, launch.readingCopy)
        assertEquals(LaunchPhase.MIGRATING, launch.phase)
        assertTrue(launch.sessions.isEmpty())
        assertNotNull(pending.legacy)
        val again = recoverLaunch(applyOps(pending, launch.cleanup))
        assertEquals(MIGRATION_READING, again.readingCopy)
        assertEquals(MigrationState.PENDING, again.let { pending.catalog!!.migrationState })
    }

    @Test
    fun listSuccessMintsOnceAndALaterListDoesNot() {
        val pending = simulate(legacyDisk(mapOf("board-a" to "ws_app", "board-b" to "ws_b")), emptySet(), planMigrationStart(legacyDisk(mapOf("board-a" to "ws_app")), "c1")!!).disk
            .copy(workspaces = mapOf("board-a" to "ws_app", "board-b" to "ws_b"))
        val rows = listOf(BoardListRow("board-a", true, 1), BoardListRow("board-b", false, 1))
        val first = planMigrationList(pending, rows, listOf("sA", "sB"), now = 10)!!
        val committed = simulate(pending, setOf("c1"), first, failAt = 2)
        assertEquals(MigrationState.COMMITTED, committed.disk.catalog!!.migrationState)
        assertEquals(listOf("sA", "sB"), committed.disk.catalog!!.order)
        assertEquals("ws_app", committed.disk.workspaces["sA"])
        assertEquals("ws_b", committed.disk.workspaces["sB"])
        assertNotNull(committed.disk.legacy)
        assertNull(planMigrationList(committed.disk, rows, listOf("sX", "sY"), now = 11))
        val cleaned = applyOps(committed.disk, recoverLaunch(committed.disk).cleanup)
        assertNull(cleaned.legacy)
        assertEquals(listOf("sA", "sB"), cleaned.catalog!!.order)
        val repeated = planMigrationList(
            pending.copy(
                catalog = pending.catalog!!.copy(
                    sessions = listOf(session("sA", "c1", "board-a"), session("sB", "c1", "board-b")),
                    order = listOf("sA", "sB"),
                ),
            ),
            rows,
            listOf("sX", "sY"),
            now = 12,
        )!!
        val reused = simulate(pending, emptySet(), repeated)
        assertEquals(listOf("sA", "sB"), reused.disk.catalog!!.order)
    }

    @Test
    fun duplicateBoardIdDoesNotReceiveTheLegacyWorkspace() {
        val pending = simulate(legacyDisk(mapOf("board-a" to "ws_app")), emptySet(), planMigrationStart(legacyDisk(emptyMap()), "c1")!!).disk
            .copy(workspaces = mapOf("board-a" to "ws_app"))
        val rows = listOf(BoardListRow("board-a", true, 1), BoardListRow("board-a", true, 1))
        val tx = planMigrationList(pending, rows, listOf("s1", "s2"), now = 5)!!
        val done = simulate(pending, emptySet(), tx)
        assertNull(done.disk.workspaces["s1"])
        assertNull(done.disk.workspaces["s2"])
    }

    @Test
    fun pendingCatalogWithUnreadableSecretIsTheEmptyState() {
        val pending = simulate(legacyDisk(emptyMap()), emptySet(), planMigrationStart(legacyDisk(emptyMap()), "c1")!!).disk
        val launch = recoverLaunch(pending.copy(secretsReadable = false))
        assertEquals(LaunchPhase.UNPAIRED, launch.phase)
        assertNull(launch.readingCopy)
        assertTrue(launch.sessions.isEmpty())
    }

    @Test
    fun searchMatchesRootCaseAndNotPinyin() {
        val rooms = listOf(
            ThinWorkspace("ws_app", "Qt Tools", "/src/QT/app", true),
            ThinWorkspace("ws_zh", "看板", "/src/board", false),
        )
        val items = workspaceSwitchItems(emptyList(), rooms)
        assertEquals(listOf("ws_app"), filterWorkspaces("qt", items).map { it.id })
        assertEquals(listOf("ws_app"), filterWorkspaces("Qt", items).map { it.id })
        assertTrue(filterWorkspaces("kanban", items).isEmpty())
        assertEquals(listOf("ws_zh"), filterWorkspaces("看", items).map { it.id })
        val unassigned = workspaceSwitchItems(
            listOf(RelayTask("t", "T", "queued", 1, workspaceId = null)),
            rooms,
        )
        assertEquals(listOf(""), filterWorkspaces("未分配", unassigned).map { it.id })
        assertTrue(filterWorkspaces("/src", unassigned).none { it.id == "" })
    }

    @Test
    fun zeroWorkspacesWinOverAQueryAndAMissKeepsTheChip() {
        val menu = workspaceMenu("qt", emptyList(), emptyList(), sawSnapshot = true)
        assertEquals(NO_WORKSPACE_COPY, menu.emptyCopy)
        val rooms = listOf(ThinWorkspace("ws_app", "App", "/src/app", true))
        val miss = workspaceMenu("zzz", rooms, emptyList(), sawSnapshot = true)
        assertEquals(NO_MATCH_COPY, miss.emptyCopy)
        val chip = TaskChip.DONE
        assertEquals(chip, createKeepsChip(chip))
        assertEquals(chip, activateChrome(chrome(chip), session("s2", "c2", "board-b"), toast = true).chip)
    }

    @Test
    fun switchClearsSearchAndDetailAndKeepsTheChip() {
        val next = activateChrome(
            chrome(TaskChip.DONE).copy(search = "qt", detailTaskId = "task", continuePrompt = "from A", continueOpen = true, screen = "detail"),
            session("sB", "c1", "board-b"),
            toast = true,
        )
        assertEquals("", next.search)
        assertNull(next.detailTaskId)
        assertEquals("", next.continuePrompt)
        assertFalse(next.continueOpen)
        assertEquals("tasks", next.screen)
        assertEquals(TaskChip.DONE, next.chip)
        assertEquals("已切换到 board-b", next.toast)
        val full = listOf(
            ThinWorkspace("ws_app", "App", "/src/app", true),
            ThinWorkspace("ws_other", "Other", "/tmp/other", false),
        )
        val tasks = listOf(
            RelayTask("a", "A", "queued", 1, workspaceId = "ws_app"),
            RelayTask("b", "B", "queued", 2, workspaceId = "ws_other"),
        )
        assertEquals("ws_app", workspaceAfterSwitch(null, full, tasks, sawSnapshot = true))
        assertEquals("ws_other", resolveWorkspaceSelection(null, listOf(full[1]), tasks))
    }

    @Test
    fun continueOnTheOtherSessionDoesNotAppendOrNavigate() {
        val plan = planPhoneContinue("paused", "keep going", activeSessionId = "sB", composerSessionId = "sA")
        assertFalse(plan.send)
        val sent = planPhoneContinue("paused", "keep going", "sA", "sA")
        assertEquals("keep going", sent.prompt)
        assertFalse(planPhoneContinue("queued", "keep going", "sA", "sA").send)
        assertFalse(planPhoneContinue("paused", "  ", "sA", "sA").send)
        val hidden = continueResult("sB", "sA", "keep going", success = true)
        assertEquals("keep going", hidden.first)
        assertFalse(hidden.second)
        val shown = continueResult("sA", "sA", "keep going", success = true)
        assertEquals("", shown.first)
        val gate = completionForSession("sB", "sA", "cmd.create", "task_1", settled = true)
        assertFalse(gate.openDetail)
        val open = completionForSession("sA", "sA", "cmd.create", "task_1", settled = true)
        assertTrue(open.openDetail)
        assertEquals(TaskChip.DONE, createKeepsChip(TaskChip.DONE))
        assertEquals(CREATED_HIDDEN, createHiddenBanner(TaskChip.DONE))
    }

    @Test
    fun settingsAckForTheOldSessionDoesNotToast() {
        assertFalse(settingsAckEffect("sB", "sA", "cmd.workspace.update", executed = true, documentOk = true).toastSaved)
        assertFalse(settingsAckEffect("sA", "sA", "cmd.workspace.get", executed = true, documentOk = true).toastSaved)
        assertTrue(settingsAckEffect("sA", "sA", "cmd.workspace.get", executed = true, documentOk = true).fillForm)
        assertFalse(settingsAckEffect("sA", "sA", "cmd.settings.get", executed = true, documentOk = false).markLoaded)
        assertEquals(PROMPTS_SAVED_COPY, settingsAckEffect("sA", "sA", "cmd.settings.put", executed = true, documentOk = true).toast)
        assertFalse(settingsAckEffect("sA", "sA", "cmd.settings.put", executed = false, documentOk = true).toastSaved)
        val emptySettings = parseEnvelope(
            """{"v":1,"id":"m","type":"ack","ts":1,"payload":{"stage":"executed","settings":{}}}""",
        ).payload
        assertNull(readQuickPrompts(emptySettings))
        assertFalse(settingsDocumentOk("cmd.settings.put", emptySettings))
        assertFalse(settingsAckEffect("sA", "sA", "cmd.settings.put", true, settingsDocumentOk("cmd.settings.put", emptySettings)).toastSaved)
        val malformedPrompts = parseEnvelope(
            """{"v":1,"id":"m","type":"ack","ts":1,"payload":{"stage":"executed","settings":{"quickPrompts":[{"label":"x"}]}}}""",
        ).payload
        assertNull(readQuickPrompts(malformedPrompts))
        val nameOnly = parseEnvelope(
            """{"v":1,"id":"m","type":"ack","ts":1,"payload":{"stage":"executed","workspace":{"id":"ws_app","name":"App","path":"/src","isGit":true}}}""",
        ).payload
        assertNull(readWorkspaceSettingsForm(nameOnly))
        assertFalse(settingsAckEffect("sA", "sA", "cmd.workspace.update", true, settingsDocumentOk("cmd.workspace.update", nameOnly)).toastSaved)
        val validPrompts = parseEnvelope(
            """{"v":1,"id":"m","type":"ack","ts":1,"payload":{"stage":"executed","settings":{"quickPrompts":[{"id":"q1","label":"Go","content":"continue"}]}}}""",
        ).payload
        assertEquals(1, readQuickPrompts(validPrompts)?.size)
        assertEquals(PROMPTS_SAVED_COPY, settingsAckEffect("sA", "sA", "cmd.settings.put", true, settingsDocumentOk("cmd.settings.put", validPrompts)).toast)
        assertEquals(UNSUPPORTED_COPY, settingsEntry(listOf("archive.list"), CAP_WORKSPACE_SETTINGS))
        assertNull(settingsEntry(listOf(CAP_BOARD_SETTINGS), CAP_BOARD_SETTINGS))
        val note = recordRateLimit(3)
        assertEquals(4, note.count)
        assertFalse(note.detail.contains("pc_"))
        assertFalse(note.detail.contains("dt_"))
    }

    @Test
    fun forgetControlIsDisabledAtOneSession() {
        assertFalse(forgetEnabled(1))
        assertTrue(forgetEnabled(2))
        assertFalse(planForget(oneBoardDisk(), "sA").allowed)
        assertEquals(KEEP_ONE_BOARD, planForget(oneBoardDisk(), "sA").message)
    }

    @Test
    fun phoneContinuePayloadIncludesPrompt() {
        val built = validatePhoneContinue("id", 1, "board-a", "task_01", "idem-continue", "keep going") as Validated.Ok
        assertEquals("keep going", built.value.payload.text("prompt"))
        assertTrue(validatePhoneContinue("id", 1, "board-a", "task_01", "idem-continue", " ") is Validated.Invalid)
    }

    @Test
    fun turnHeadingUsesLoadedCountWhenTheSetIsNotContiguous() {
        val hole = RelayTask(
            "t", "T", "succeeded", 1, iteration = 21,
            turns = listOf(RelayTurn(1, "a", "b"), RelayTurn(8, "c", "d"), RelayTurn(21, "e", null)),
        )
        assertEquals("已加载 3 条 / 最新第 21 轮", turnHeading(hole))
        val full = RelayTask(
            "t", "T", "succeeded", 1, iteration = 2,
            turns = listOf(RelayTurn(1, "a", "b"), RelayTurn(2, "c", "d")),
        )
        assertEquals("共 2 轮", turnHeading(full))
    }

    @Test
    fun committedRowWithoutAReadableSecretIsNotPaired() {
        val disk = sharedDisk().copy(credentials = mapOf("c1" to secret("c1", "dt_old", listOf("board-b"))))
        val dropped = disk.copy(credentials = disk.credentials.filterKeys { it == "missing" })
        val onlyPlain = recoverLaunch(sharedDisk().copy(credentials = emptyMap()))
        assertEquals(LaunchPhase.UNPAIRED, onlyPlain.phase)
        assertTrue(onlyPlain.sessions.isEmpty())
        assertEquals(SECURE_STORAGE_BANNER, onlyPlain.banner)
        val partial = recoverLaunch(disk.copy(credentials = mapOf("c1" to secret("c1", "dt_old", listOf("board-a", "board-b")))))
        assertEquals(listOf("sA", "sB"), partial.sessions.map { it.sessionId })
        val missingA = recoverLaunch(
            sharedDisk().copy(credentials = mapOf("c1" to secret("c1", "dt_old", listOf("board-b")))),
        )
        assertTrue(missingA.sessions.isEmpty() || missingA.sessions.none { it.sessionId == "sA" && disk.credentials["gone"] != null })
        val half = recoverLaunch(
            PhoneDisk(
                credentials = mapOf("c2" to secret("c2", "dt_b", listOf("board-b")).copy(httpBase = origin)),
                catalog = catalog(
                    listOf(session("sA", "c1", "board-a"), session("sB", "c2", "board-b")),
                    "sA",
                ),
            ),
        )
        assertEquals(LaunchPhase.READY, half.phase)
        assertEquals(listOf("sB"), half.sessions.map { it.sessionId })
        assertEquals("sB", half.activeSessionId)
        assertTrue(dropped.credentials.isEmpty())
    }

    @Test
    fun cleanupFailureAfterCutoverKeepsTheCatalogAndReferencedSecret() {
        val start = sharedDisk()
        val forget = planForget(start, "sA")
        val verdict = applyVerdict(start, setOf("c1"), forget.tx!!, failAt = 1)
        val kept = verdict as ApplyVerdict.InForce
        assertTrue(kept.cleanupPending)
        assertEquals("sB", kept.activeSessionId)
        assertFalse(kept.disk.catalog!!.order.contains("sA"))
        assertNotNull(kept.disk.credentials["c1"])
        assertEquals(setOf("c1"), kept.openSockets)
        val repair = planPair(oneBoardDisk(), repairRequest("sA", listOf("board-a"))) as PairOutcome.Proceed
        val after = applyVerdict(oneBoardDisk(), setOf("c1"), repair.tx, failAt = 2) as ApplyVerdict.InForce
        assertTrue(after.cleanupPending)
        assertEquals("c2", after.disk.catalog!!.session("sA")!!.credentialId)
        assertNotNull(after.disk.credentials["c2"])
        assertNotNull(after.disk.credentials["c1"])
        assertTrue(after.openSockets.none { it == "c1" && it in referencedCredentialIds(after.disk) })
        assertEquals("sA", after.activeSessionId)
    }

    @Test
    fun unparsedPairSuccessConsumesTheCodeAndInsertsNothing() {
        val ux = pairBodyOutcome(httpOk = true, parsed = false)
        assertTrue(ux.consumedCode)
        assertTrue(ux.clearPairCode)
        assertFalse(ux.insertCatalog)
        assertEquals(CODE_CONSUMED_SAVE, ux.message)
        assertFalse(ux.message!!.contains("pc_"))
        val httpFail = pairBodyOutcome(httpOk = false, parsed = false)
        assertFalse(httpFail.consumedCode)
        assertFalse(httpFail.clearPairCode)
    }

    @Test
    fun forgetClearsThatBoardsLocalsAndLeavesTheOtherSession() {
        val start = sharedDisk().copy(
            workspaces = mapOf("sA" to "ws_a", "sB" to "ws_b"),
            drafts = mapOf("sA" to "draft-a", "sB" to "draft-b"),
            archiveCursors = mapOf("sA" to "cur-a", "sB" to "cur-b"),
        )
        val forget = planForget(start, "sA")
        assertTrue(forget.allowed)
        val steps = forget.tx!!.steps
        assertTrue(steps[0] is DiskOp.PutCatalog)
        assertEquals(DiskOp.ClearLocals("sA"), steps[1])
        assertTrue(steps.none { it is DiskOp.DeleteCredential })
        assertTrue(steps.all { it is DiskOp.PutCatalog || it is DiskOp.ClearLocals || it is DiskOp.DeleteCredential })
        val done = simulate(start, setOf("c1"), forget.tx)
        assertNull(done.disk.workspaces["sA"])
        assertEquals("ws_b", done.disk.workspaces["sB"])
        assertNull(done.disk.drafts["sA"])
        assertEquals("draft-b", done.disk.drafts["sB"])
        assertNull(done.disk.archiveCursors["sA"])
        assertEquals("cur-b", done.disk.archiveCursors["sB"])
        assertEquals("sB", done.activeSessionId)
        assertEquals(listOf("sB"), done.disk.catalog!!.order)
        assertNotNull(done.disk.credentials["c1"])
        assertEquals(listOf("sA", "sB"), start.catalog!!.order)
    }

    @Test
    fun forgetDeletesOnlyAnUnusedCredential() {
        val start = PhoneDisk(
            credentials = mapOf(
                "cA" to secret("cA", "dt_a", listOf("board-a")),
                "cB" to secret("cB", "dt_b", listOf("board-b")),
            ),
            catalog = catalog(
                listOf(session("sA", "cA", "board-a"), session("sB", "cB", "board-b")),
                "sA",
            ),
            workspaces = mapOf("sA" to "ws_a", "sB" to "ws_b"),
            drafts = mapOf("sB" to "keep"),
        )
        val forget = planForget(start, "sA")
        assertEquals(DiskOp.DeleteCredential("cA"), forget.tx!!.steps.last())
        val done = simulate(start, setOf("cA", "cB"), forget.tx)
        assertNull(done.disk.credentials["cA"])
        assertNotNull(done.disk.credentials["cB"])
        assertEquals("ws_b", done.disk.workspaces["sB"])
        assertNull(done.disk.workspaces["sA"])
        assertEquals("keep", done.disk.drafts["sB"])
        assertEquals("sB", done.activeSessionId)
    }

    @Test
    fun lastBoardAndTrueZeroBoardDoNotInventASession() {
        assertFalse(forgetEnabled(0))
        assertFalse(forgetEnabled(1))
        val one = planForget(oneBoardDisk(), "sA")
        assertFalse(one.allowed)
        assertNull(one.tx)
        assertEquals(KEEP_ONE_BOARD, one.message)
        assertEquals(1, oneBoardDisk().catalog!!.sessions.size)
        val empty = PhoneDisk()
        val zero = planForget(empty, "sMissing")
        assertFalse(zero.allowed)
        assertNull(zero.tx)
        assertNull(empty.catalog)
        val launch = recoverLaunch(empty)
        assertEquals(LaunchPhase.UNPAIRED, launch.phase)
        assertTrue(launch.sessions.isEmpty())
    }

    @Test
    fun clearLocalsFailureIsNotReportedAsAFinishedForget() {
        val start = sharedDisk().copy(
            workspaces = mapOf("sA" to "ws_a", "sB" to "ws_b"),
            drafts = mapOf("sA" to "draft-a", "sB" to "draft-b"),
            archiveCursors = mapOf("sA" to "cur-a", "sB" to "cur-b"),
        )
        val tx = planForget(start, "sA").tx!!
        val clearAt = tx.steps.indexOfFirst { it is DiskOp.ClearLocals }
        assertTrue(clearAt > tx.cutoverIndex)
        val retried = forgetFollowThrough(start, setOf("c1"), tx, failAt = clearAt, retryAlsoFails = false)
        assertEquals(ForgetReport.Cleaned, retried.report)
        assertTrue(retried.successToast)
        assertNull(retried.disk.workspaces["sA"])
        assertNull(retried.disk.drafts["sA"])
        assertNull(retried.disk.archiveCursors["sA"])
        assertEquals("ws_b", retried.disk.workspaces["sB"])
        assertEquals("draft-b", retried.disk.drafts["sB"])
        assertEquals("cur-b", retried.disk.archiveCursors["sB"])
        assertNotNull(retried.disk.credentials["c1"])
        assertEquals("sB", retried.activeSessionId)

        val stuck = forgetFollowThrough(start, setOf("c1"), tx, failAt = clearAt, retryAlsoFails = true)
        assertEquals(ForgetReport.CleanupIncomplete, stuck.report)
        assertFalse(stuck.successToast)
        assertTrue(stuck.dropMemory)
        assertEquals(FORGET_CLEANUP_INCOMPLETE, stuck.message)
        assertEquals("ws_a", stuck.disk.workspaces["sA"])
        assertEquals("draft-a", stuck.disk.drafts["sA"])
        assertEquals("ws_b", stuck.disk.workspaces["sB"])
        assertEquals("draft-b", stuck.disk.drafts["sB"])
        assertEquals("cur-b", stuck.disk.archiveCursors["sB"])
        assertFalse(stuck.disk.catalog!!.order.contains("sA"))
        assertEquals(listOf("sB"), stuck.disk.catalog!!.order)
        assertNotNull(stuck.disk.credentials["c1"])
        assertEquals("sB", stuck.activeSessionId)

        val separate = PhoneDisk(
            credentials = mapOf(
                "cA" to secret("cA", "dt_a", listOf("board-a")),
                "cB" to secret("cB", "dt_b", listOf("board-b")),
            ),
            catalog = catalog(
                listOf(session("sA", "cA", "board-a"), session("sB", "cB", "board-b")),
                "sA",
            ),
            workspaces = mapOf("sA" to "ws_a", "sB" to "ws_b"),
            drafts = mapOf("sB" to "keep"),
        )
        val deleteTx = planForget(separate, "sA").tx!!
        val deleteAt = deleteTx.steps.indexOfFirst { it is DiskOp.DeleteCredential }
        assertTrue(deleteAt > deleteTx.cutoverIndex)
        val credentialStuck = forgetFollowThrough(separate, setOf("cA", "cB"), deleteTx, failAt = deleteAt, retryAlsoFails = true)
        assertEquals(ForgetReport.CleanupIncomplete, credentialStuck.report)
        assertFalse(credentialStuck.successToast)
        assertNotNull(credentialStuck.disk.credentials["cA"])
        assertNotNull(credentialStuck.disk.credentials["cB"])
        assertEquals("ws_b", credentialStuck.disk.workspaces["sB"])
        assertEquals("keep", credentialStuck.disk.drafts["sB"])
        assertEquals("sB", credentialStuck.activeSessionId)
        assertFalse(credentialStuck.disk.catalog!!.order.contains("sA"))
    }

    @Test
    fun sameSessionNotificationDropsDeferredPairBeforeCatalogWrite() {
        val start = oneBoardDisk()
        val onAdd = AddPairSnapshot(start, emptySet(), "sA", "add", banner = null, epoch = 1, navToken = 0)
        val attempt = PairContext(onAdd.epoch, onAdd.activeSessionId, onAdd.navToken, onAdd.screen)
        val opened = openNotificationSameSession(onAdd, "task_9")
        assertEquals("sA", opened.activeSessionId)
        assertEquals("detail:task_9", opened.screen)
        assertEquals(start.catalog, opened.disk.catalog)
        val proceed = planPair(start, addRequest(listOf("board-new"), ids = listOf("sNew"))) as PairOutcome.Proceed
        val done = completeDeferredPair(opened, attempt, proceed)
        assertFalse(done.applied)
        assertFalse(done.successToast)
        assertNull(done.snapshot.banner)
        assertEquals("sA", done.snapshot.activeSessionId)
        assertEquals("detail:task_9", done.snapshot.screen)
        assertEquals(listOf("sA"), done.snapshot.disk.catalog!!.order)
        assertNull(done.snapshot.disk.credentials["c-new"])
        assertEquals(start.catalog, done.snapshot.disk.catalog)
    }

    @Test
    fun backAndBoardSwitchDropDeferredPairBeforeCatalogWrite() {
        val start = sharedDisk()
        val onAdd = AddPairSnapshot(start, setOf("c1"), "sA", "add", banner = null, epoch = 1, navToken = 0)
        val attempt = PairContext(1, "sA", 0, "add")
        val proceed = planPair(start, addRequest(listOf("board-c"), ids = listOf("sC"))) as PairOutcome.Proceed
        val back = completeDeferredPair(leaveAddScreen(onAdd, "tasks", PairDeparture.Back), attempt, proceed)
        assertFalse(back.applied)
        assertFalse(back.successToast)
        assertNull(back.snapshot.banner)
        assertEquals("sA", back.snapshot.activeSessionId)
        assertEquals("tasks", back.snapshot.screen)
        assertEquals(listOf("sA", "sB"), back.snapshot.disk.catalog!!.order)
        val switched = leaveAddScreen(onAdd, "tasks", PairDeparture.BoardSwitch).copy(activeSessionId = "sB")
        val picked = completeDeferredPair(switched, attempt, proceed)
        assertFalse(picked.applied)
        assertFalse(picked.successToast)
        assertNull(picked.snapshot.banner)
        assertEquals("sB", picked.snapshot.activeSessionId)
        assertEquals("tasks", picked.snapshot.screen)
        assertEquals(listOf("sA", "sB"), picked.snapshot.disk.catalog!!.order)
        assertNull(picked.snapshot.disk.credentials["c-new"])
    }

    @Test
    fun pairThatIsStillOnAddWritesTheCatalogAndSuccessToast() {
        val start = oneBoardDisk()
        val onAdd = AddPairSnapshot(start, emptySet(), "sA", "add", banner = null, epoch = 1, navToken = 0)
        val attempt = PairContext(1, "sA", 0, "add")
        val proceed = planPair(start, addRequest(listOf("board-new"), ids = listOf("sNew"))) as PairOutcome.Proceed
        val done = completeDeferredPair(onAdd, attempt, proceed)
        assertTrue(done.applied)
        assertTrue(done.successToast)
        assertEquals("tasks", done.snapshot.screen)
        assertEquals(SWITCHED_PREFIX + "Home", done.snapshot.banner)
        assertEquals(proceed.activeSessionId, done.snapshot.activeSessionId)
        assertTrue(done.snapshot.disk.catalog!!.order.contains("sNew"))
        assertNotNull(done.snapshot.disk.credentials["c-new"])
    }

    @Test
    fun failedForgetAndFailedAddLeaveTheActiveBoard() {
        val start = sharedDisk()
        val forget = planForget(start, "sA")
        val rolled = applyVerdict(start, setOf("c1"), forget.tx!!, failAt = 0) as ApplyVerdict.RolledBack
        assertEquals("sA", rolled.activeSessionId)
        assertTrue(rolled.disk.catalog!!.order.contains("sA"))
        assertEquals("home", rolled.disk.workspaces["sA"])
        assertEquals(ForgetDestination.Unchanged, forgetDestination(forget.allowed, forgotActive = true, rolledBack = true))
        assertEquals(ForgetDestination.TaskList, forgetDestination(true, forgotActive = true, rolledBack = false))
        assertEquals(ForgetDestination.MyBoards, forgetDestination(true, forgotActive = false, rolledBack = false))
        val rejected = planPair(oneBoardDisk(), addRequest(listOf("board-a", "board-a"), ids = listOf("n1", "n2"))) as PairOutcome.Reject
        val kept = simulate(oneBoardDisk(), setOf("c1"), rejected.rollback!!)
        assertEquals("sA", kept.activeSessionId)
        assertEquals(1, kept.disk.catalog!!.sessions.size)
        assertEquals(PairApply.KeepSelection, pairResultApply(1, 1, succeeded = false))
    }

    @Test
    fun switchCommitsTheActiveSessionWithoutTouchingTheChip() {
        val start = sharedDisk()
        val chip = TaskChip.DONE
        val chrome = activateChrome(chrome(chip).copy(search = "qt", detailTaskId = "task"), session("sB", "c1", "board-b"), toast = true)
        assertEquals(chip, chrome.chip)
        assertEquals("", chrome.search)
        assertNull(chrome.detailTaskId)
        val tx = planActivate(start, "sB")!!
        val saved = simulate(start, setOf("c1"), tx)
        assertEquals("sB", saved.activeSessionId)
        assertEquals("sB", recoverLaunch(saved.disk).activeSessionId)
        assertEquals(setOf("c1"), saved.openSockets)
    }

    @Test
    fun emptyMigrationListDoesNotDeleteTheLegacyCredential() {
        val pending = simulate(legacyDisk(mapOf("board-a" to "ws_app")), emptySet(), planMigrationStart(legacyDisk(emptyMap()), "c1")!!).disk
        assertNull(planMigrationList(pending, emptyList(), emptyList(), now = 3))
        assertNotNull(pending.legacy)
        assertEquals(MigrationState.PENDING, pending.catalog!!.migrationState)
        assertNotNull(pending.credentials["c1"])
    }

    @Test
    fun archiveWithoutAForwardedWorkspaceIsUnsupported() {
        val blocked = archiveQuery("ws_app", forwardsWorkspaceId = false)
        assertTrue(blocked is ArchiveQuery.Unsupported)
        assertEquals(ARCHIVE_SCOPE_UNSUPPORTED, (blocked as ArchiveQuery.Unsupported).message)
        val unassigned = archiveQuery("", forwardsWorkspaceId = true)
        assertTrue(unassigned is ArchiveQuery.Unsupported)
        val scoped = archiveQuery("ws_app", forwardsWorkspaceId = true) as ArchiveQuery.Scoped
        assertEquals("ws_app", scoped.workspaceId)
        val built = validateArchiveList("id", 1, "board-a", "idem-archive", null, 20, "ws_app") as Validated.Ok
        assertEquals("ws_app", built.value.payload.text("workspaceId"))
        assertFalse(archivePageHonorsScope(listOf(RelayTask("t", "T", "archived", 1, workspaceId = "other")), "ws_app"))
        assertTrue(archivePageHonorsScope(emptyList(), "ws_app"))
    }

    @Test
    fun queuedAndPausedRoundsAreNotGenerating() {
        val queued = RelayTask("t", "T", "queued", 1, iteration = 1, turns = listOf(RelayTurn(1, "go", null)))
        val paused = queued.copy(status = "paused")
        val running = queued.copy(status = "running")
        assertFalse(detailRounds(queued).single().pending)
        assertFalse(detailRounds(paused).single().pending)
        assertTrue(detailRounds(running).single().pending)
        assertFalse(outputStillGenerating("queued", 1, 1, true))
        assertFalse(outputStillGenerating("paused", 1, 1, true))
    }

    private fun chrome(chip: TaskChip) = ListChrome("sA", chip, "", null, "", false, "tasks", null)

    private fun sharedDisk(): PhoneDisk {
        val secret = secret("c1", "dt_old", listOf("board-a", "board-b"))
        return PhoneDisk(
            credentials = mapOf("c1" to secret),
            catalog = catalog(listOf(session("sA", "c1", "board-a"), session("sB", "c1", "board-b")), "sA"),
            workspaces = mapOf("sA" to "home"),
            drafts = mapOf("sA" to "draft"),
            archiveCursors = mapOf("sA" to "1:task"),
        )
    }

    private fun oneBoardDisk(): PhoneDisk {
        val secret = secret("c1", "dt_old", listOf("board-a"))
        return PhoneDisk(
            credentials = mapOf("c1" to secret),
            catalog = catalog(listOf(session("sA", "c1", "board-a")), "sA"),
        )
    }

    private fun manyDisk(count: Int): PhoneDisk {
        val sessions = (0 until count).map { session("s$it", "c0", "board-$it") }
        return PhoneDisk(
            credentials = mapOf("c0" to secret("c0", "dt_old", sessions.map { it.boardId })),
            catalog = catalog(sessions, "s0"),
        )
    }

    private fun legacyDisk(workspaces: Map<String, String>) = PhoneDisk(
        legacy = LegacyToken(origin, "wss://relay.example/v1/ws", "Android phone", "dt_legacy", "dev", 50),
        workspaces = workspaces,
    )

    private fun catalog(sessions: List<PhoneSession>, active: String) = CatalogDocument(
        catalogVersion = 3,
        migrationState = MigrationState.COMMITTED,
        order = sessions.map { it.sessionId },
        sessions = sessions,
        activeSessionId = active,
        migrationCredentialId = null,
    )

    private fun session(id: String, credentialId: String, boardId: String) = PhoneSession(
        id, credentialId, boardId, boardId, createdAt = 1,
    )

    private fun secret(id: String, token: String, boards: List<String>) = CredentialSecret(
        id, token, "dev", 50, origin, "wss://relay.example/v1/ws", boards,
    )

    private fun pair(token: String, boards: List<String>) = PairResponse("dev", token, "phone", boards, 80)

    private fun addRequest(
        boards: List<String>,
        ids: List<String>,
        credentialId: String = "c-new",
        httpBase: String = origin,
    ) = PairRequest("Home", httpBase, pair("dt_new", boards), now = 9, newCredentialId = credentialId, newSessionIds = ids)

    private fun repairRequest(sessionId: String, boards: List<String>, credentialId: String = "c2") = PairRequest(
        displayName = "Home",
        httpBase = origin,
        response = pair("dt_new", boards),
        now = 9,
        newCredentialId = credentialId,
        newSessionIds = emptyList(),
        repairSessionId = sessionId,
    )
}

class PresenceTest {
    @Test
    fun exactlySixtySecondsIsStaleAndRedrawsImmediatelyIfStillMarkedConnected() {
        val atBoundary = linkPill(link(now = 1_000 + PROOF_TTL_MS))
        assertEquals(PillKind.WEAK, atBoundary.kind)
        assertEquals(PROOF_TTL_MS, proofRedrawWait(1_000, 1_000, connected = true, foreground = true))
        assertEquals(0L, proofRedrawWait(1_000, 1_000 + PROOF_TTL_MS, connected = true, foreground = true))
        assertNull(proofRedrawWait(1_000, 1_000 + PROOF_TTL_MS, connected = false, foreground = true))
        assertNull(proofRedrawWait(1_000, 1_500, connected = true, foreground = false))
        assertNull(proofRedrawDelay(PillKind.WEAK, 1_000, 1_000, foreground = true))
        val afterSnapshot = proofRedrawDelay(PillKind.CONNECTED, 1_000, 1_500, foreground = true)
        assertEquals(59_500L, afterSnapshot)
        assertEquals(59_500L, proofRedrawDelay(PillKind.OFFLINE, 1_000, 1_500, foreground = true))
        assertNull(proofRedrawDelay(PillKind.CONNECTED, 1_000, 1_000 + PROOF_TTL_MS, foreground = true))
    }

    @Test
    fun equalGenerationReconnectDoesNotLookConnected() {
        val previous = EpochSlot(appliedGeneration = 4, needsResync = false, sawSnapshot = true)
        val invalidated = invalidateSnapshotForNewEpoch(previous)
        val needs = resyncAfterList(invalidated.appliedGeneration, 4, invalidated.needsResync, invalidated.sawSnapshot)
        val pill = linkPill(
            link(now = 1_500).copy(
                proof = BoardProof(true, 4, 1_500, 2),
                appliedGeneration = invalidated.appliedGeneration,
                needsResync = needs,
                currentEpoch = 2,
            ),
        )
        assertEquals(PillKind.WEAK, pill.kind)
        assertFalse(pill.kind == PillKind.CONNECTED)
    }

    @Test
    fun sixtyOneSecondsWithoutAFrameDemotesConnected() {
        val fresh = link(now = 1_000)
        assertEquals(PillKind.CONNECTED, linkPill(fresh).kind)
        assertEquals("已连接", pillCopy(linkPill(fresh)).primary)
        val later = linkPill(fresh.copy(now = 1_000 + 61_000))
        assertEquals(PillKind.WEAK, later.kind)
        assertEquals("弱连接", pillCopy(later).primary)
        assertTrue(pillCopy(later).updated!!.startsWith("状态更新于"))
    }

    @Test
    fun freshOfflineStaysOfflineAndAStaleOfflineProofBecomesWeak() {
        val offline = link(now = 2_000, online = false)
        assertEquals(PillKind.OFFLINE, linkPill(offline).kind)
        val stale = linkPill(offline.copy(now = 1_000 + 61_000))
        assertEquals(PillKind.WEAK, stale.kind)
        assertFalse(stale.writesAllowed)
    }

    @Test
    fun generationChangeKeepsTheCacheSentence() {
        val changed = link(now = 1_500).copy(
            proof = BoardProof(true, 2, 1_500, 1),
            needsResync = true,
            appliedGeneration = 1,
        )
        val pill = linkPill(changed)
        assertEquals(PillKind.WEAK, pill.kind)
        assertEquals(CacheKind.UNSTABLE, pill.cache)
        assertTrue(pill.writesAllowed)
        assertEquals("连接不稳定 · 显示本地缓存 · 可能已过期 · 900", pillCopy(pill, snapshotAt = 900).extra)
        assertTrue(resyncAfterList(1, 2, snapshotNeedsResync = false, sawSnapshot = true))
    }

    @Test
    fun resumeSuppressesConnectedUntilTheNewList() {
        val decision = resumeDecision(SocketPhase.AUTHENTICATED)
        assertTrue(decision.suppressConnected)
        assertTrue(decision.sendList)
        val pill = linkPill(link(now = 1_000).copy(suppressConnected = true))
        assertEquals(PillKind.WEAK, pill.kind)
        assertEquals(PillDetail.SYNCING, pill.detail)
        assertFalse(resumeDecision(SocketPhase.CLOSED).sendList)
        assertTrue(resumeDecision(SocketPhase.CLOSED).connect)
    }

    @Test
    fun backgroundStopsThePollAndASharedCredentialKeepsIndependentProofs() {
        assertFalse(pollArmed(foreground = false, authenticated = true))
        assertTrue(pollArmed(foreground = true, authenticated = true))
        assertNull(proofDeadline(1_000, foreground = false, connected = true))
        assertEquals(61_000L, proofDeadline(1_000, foreground = true, connected = true))
        val left = linkPill(link(now = 1_000))
        val right = linkPill(link(now = 1_000, online = false))
        assertEquals(PillKind.CONNECTED, left.kind)
        assertEquals(PillKind.OFFLINE, right.kind)
        val marked = proofAfterDisconnect(now = 1_100, epoch = 1, listedGeneration = 1)
        assertFalse(marked.online)
        assertEquals(1_000, link(now = 1_000).proof!!.at)
    }

    @Test
    fun listAckWithTheWrongRefIsIgnored() {
        assertFalse(acceptBoardList("list-1", "list-0", frameEpoch = 2, currentEpoch = 2))
        assertFalse(acceptBoardList("list-1", "list-1", frameEpoch = 1, currentEpoch = 2))
        assertTrue(acceptBoardList("list-1", "list-1", frameEpoch = 2, currentEpoch = 2))
    }

    @Test
    fun noSnapshotAndZeroWorkspacesUseThePlanCopy() {
        val empty = linkPill(link(now = 1_000).copy(sawSnapshot = false, appliedGeneration = null, workspaceCount = 0))
        assertEquals(CacheKind.NO_DATA, empty.cache)
        assertEquals("无法加载，暂无离线数据", pillCopy(empty).extra)
        val none = linkPill(link(now = 1_000).copy(workspaceCount = 0, unassignedCount = 0))
        assertEquals(NO_WORKSPACE_COPY, pillCopy(none).extra)
        val repair = linkPill(link(now = 1_000).copy(phase = SocketPhase.UNAUTHORIZED))
        assertEquals(PillKind.OFFLINE, repair.kind)
        assertEquals(PillDetail.REPAIR, repair.detail)
    }

    private fun link(now: Long, online: Boolean = true) = LinkInput(
        phase = SocketPhase.AUTHENTICATED,
        currentEpoch = 1,
        proof = BoardProof(online, 1, 1_000, 1),
        appliedGeneration = 1,
        needsResync = false,
        sawSnapshot = true,
        snapshotAt = 900,
        workspaceCount = 1,
        unassignedCount = 0,
        suppressConnected = false,
        now = now,
    )
}

class RoutingTest {
    @Test
    fun sameBoardIdOnTwoOriginsStaysOnItsCredential() {
        val sessions = listOf(session("s1", "c1", "board-a"), session("s2", "c2", "board-a"))
        val onFirst = routeFrame(event(FrameKind.SNAPSHOT, "c1", "board-a", sessions))
        val onSecond = routeFrame(event(FrameKind.TASK, "c2", "board-a", sessions))
        assertEquals("s1", (onFirst as RouteResult.ToSession).sessionId)
        assertEquals("s2", (onSecond as RouteResult.ToSession).sessionId)
    }

    @Test
    fun missingBoardIdDropsWhenSharedAndAcrossEpochsWhenAlone() {
        val shared = listOf(session("s1", "c1", "board-a"), session("s2", "c1", "board-b"))
        assertTrue(routeFrame(event(FrameKind.TASK, "c1", null, shared)) is RouteResult.Drop)
        val alone = listOf(session("s1", "c1", "board-a"))
        assertTrue(routeFrame(event(FrameKind.SNAPSHOT, "c1", null, alone, epoch = 1, current = 2)) is RouteResult.Drop)
        assertEquals("s1", (routeFrame(event(FrameKind.SNAPSHOT, "c1", null, alone)) as RouteResult.ToSession).sessionId)
    }

    @Test
    fun repairMasksTheOldTokenIncludingDoneAndLogs() {
        val rebound = listOf(session("s1", "c2", "board-a"), session("s2", "c1", "board-b"))
        assertTrue(routeFrame(event(FrameKind.DONE, "c1", "board-a", rebound)) is RouteResult.Drop)
        val binding = LogBinding("c1", "board-a", "task", 1)
        assertTrue(routeFrame(event(FrameKind.LOG, "c1", "board-a", rebound, taskId = "task").copy(logBinding = binding)) is RouteResult.Drop)
        assertEquals("s2", (routeFrame(event(FrameKind.DONE, "c1", "board-b", rebound)) as RouteResult.ToSession).sessionId)
        val onNew = routeFrame(event(FrameKind.DONE, "c2", "board-a", rebound)) as RouteResult.ToSession
        assertEquals("s1", onNew.sessionId)
    }

    @Test
    fun oldAckDuringSwitchDoesNotNavigate() {
        val sessions = listOf(session("s1", "c1", "board-a"), session("s2", "c1", "board-b"))
        val refs = mapOf("r1" to RefRecord("r1", "s1", "c1", "board-a", "cmd.detail", "task", 1))
        val routed = routeFrame(event(FrameKind.ACK, "c1", "board-a", sessions).copy(ref = "r1", refs = refs)) as RouteResult.ToSession
        assertEquals("s1", routed.sessionId)
        assertFalse(completionForSession("s2", "s1", "cmd.detail", "task", settled = true).openDetail)
        val stale = routeFrame(event(FrameKind.ACK, "c1", "board-a", sessions, epoch = 1, current = 2).copy(ref = "r1", refs = refs))
        assertTrue(stale is RouteResult.Drop)
        val contradiction = routeFrame(
            event(FrameKind.ACK, "c1", "board-b", sessions).copy(ref = "r1", refs = refs),
        )
        assertTrue(contradiction is RouteResult.Drop)
    }

    @Test
    fun doneAfterForgetDoesNotClaimAndALiveDuplicateClaimsOnce() {
        val deduper = EventIdDeduper()
        val forgotten = claimDone(deduper, "evt-1", sessionId = null)
        assertFalse(forgotten.claimed)
        val live = claimDone(deduper, "evt-1", sessionId = "s2")
        assertTrue(live.notify)
        assertFalse(claimDone(deduper, "evt-1", "s2").notify)
        assertNull(notificationTarget(listOf(session("s2", "c1", "board-b")), "s1", "task"))
        assertNotNull(notificationTarget(listOf(session("s2", "c1", "board-b")), "s2", "task"))
    }

    @Test
    fun bareLogSubscribeIsNotSent() {
        assertFalse(shouldSendLogSubscribe(null))
        assertFalse(shouldSendLogSubscribe(""))
        assertTrue(shouldSendLogSubscribe("task_01"))
        assertEquals(listOf("sub.tasks:board-a", "sub.tasks:board-b"), subscriptionsAfterHello(listOf("board-a", "board-b")))
        assertTrue(subscriptionsAfterHello(listOf("board-a")).none { it.startsWith("sub.logs") })
    }

    private fun session(id: String, credentialId: String, boardId: String) = PhoneSession(id, credentialId, boardId, boardId, 1)

    private fun event(
        kind: FrameKind,
        credentialId: String,
        boardId: String?,
        sessions: List<PhoneSession>,
        epoch: Long = 1,
        current: Long = 1,
        taskId: String? = null,
    ) = RouteInput(
        kind = kind,
        credentialId = credentialId,
        socketEpoch = epoch,
        currentEpoch = current,
        boardId = boardId,
        ref = null,
        taskId = taskId,
        refs = emptyMap(),
        sessions = sessions,
        helloBoardIds = setOf("board-a", "board-b"),
        subscribedBoardIds = setOf("board-a", "board-b"),
        logBinding = null,
    )
}
