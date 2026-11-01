package tech.mengfei.agentboard

import android.content.Context
import kotlinx.coroutines.ExperimentalCoroutinesApi
import android.content.SharedPreferences
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import tech.mengfei.agentboard.data.HttpResult
import tech.mengfei.agentboard.data.RelayApi
import tech.mengfei.agentboard.data.SessionStore
import tech.mengfei.agentboard.data.SocketListener
import tech.mengfei.agentboard.notify.DoneNotifier
import tech.mengfei.agentboard.protocol.CatalogDocument
import tech.mengfei.agentboard.protocol.CredentialSecret
import tech.mengfei.agentboard.protocol.DiskOp
import tech.mengfei.agentboard.protocol.MigrationState
import tech.mengfei.agentboard.protocol.PhoneSession
import tech.mengfei.agentboard.protocol.SWITCHED_PREFIX
import tech.mengfei.agentboard.protocol.decodeCatalog

/**
 * Holds the pair HTTP call inside [BoardViewModel.pair], then releases a successful body
 * after a real navigation entry point has left Add.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BoardViewModelPairTest {
    private val main = UnconfinedTestDispatcher()

    @Before
    fun setMain() {
        Dispatchers.setMain(main)
    }

    @After
    fun resetMain() {
        Dispatchers.resetMain()
    }

    @Test
    fun sameSessionNotificationDoesNotPersistTheDeferredPair() {
        val harness = heldAdd(listOf(board("sA", "Office", "board-a")))
        harness.model.openNotification("sA", "task_9")
        val detail = harness.model.state.value.screen
        assertEquals(Screen.Detail("sA", "task_9"), detail)
        harness.releaseSuccess()
        assertEquals(Screen.Detail("sA", "task_9"), harness.model.state.value.screen)
        assertEquals("sA", harness.model.state.value.activeSessionId)
        assertEquals("sA", harness.store.readDisk().catalog!!.activeSessionId)
        assertEquals(listOf("sA"), harness.persistedOrder())
        assertEquals(setOf("c1"), harness.store.readDisk().credentials.keys)
        assertNull(harness.model.state.value.banner)
    }

    @Test
    fun backDoesNotPersistTheDeferredPair() {
        val harness = heldAdd(listOf(board("sA", "Office", "board-a")))
        harness.model.pop()
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        harness.releaseSuccess()
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertEquals("sA", harness.model.state.value.activeSessionId)
        assertEquals("sA", harness.store.readDisk().catalog!!.activeSessionId)
        assertEquals(listOf("sA"), harness.persistedOrder())
        assertEquals(setOf("c1"), harness.store.readDisk().credentials.keys)
        assertNull(harness.model.state.value.banner)
    }

    @Test
    fun boardSelectionDoesNotPersistTheDeferredPair() {
        val harness = heldAdd(
            listOf(
                board("sA", "Office", "board-a"),
                board("sB", "Cabin", "board-b"),
            ),
        )
        harness.model.activateSession("sB", tech.mengfei.agentboard.protocol.BoardPickPath.TopSwitcher)
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertEquals("sB", harness.model.state.value.activeSessionId)
        harness.releaseSuccess()
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertEquals("sB", harness.model.state.value.activeSessionId)
        assertEquals("sB", harness.store.readDisk().catalog!!.activeSessionId)
        assertEquals(listOf("sA", "sB"), harness.persistedOrder())
        assertEquals(setOf("c1"), harness.store.readDisk().credentials.keys)
        assertEquals(SWITCHED_PREFIX + "Cabin", harness.model.state.value.banner)
        assertFalse(harness.model.state.value.banner!!.contains("Home Mac"))
    }

    @Test
    fun pairThatStaysOnAddPersistsTheNewBoard() {
        val harness = heldAdd(listOf(board("sA", "Office", "board-a")))
        assertEquals(Screen.AddBoard, harness.model.state.value.screen)
        harness.releaseSuccess()
        val order = harness.persistedOrder()
        val active = harness.store.readDisk().catalog!!.activeSessionId
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertTrue(harness.model.state.value.banner!!.startsWith(SWITCHED_PREFIX))
        assertTrue(harness.model.state.value.banner!!.contains("Home Mac"))
        assertEquals(2, order.size)
        assertEquals("sA", order.first())
        assertEquals(order.last(), active)
        assertEquals(active, harness.model.state.value.activeSessionId)
        assertEquals(2, harness.store.readDisk().credentials.size)
    }

    private fun heldAdd(sessions: List<PhoneSession>): Harness {
        val plain = MemoryPrefs()
        val secretPrefs = MemoryPrefs()
        val store = SessionStore(plain, secretPrefs)
        val boards = sessions.map { it.boardId }
        store.apply(
            DiskOp.PutCredential(
                CredentialSecret("c1", "dt_old", "dev", 50, "https://relay.example", "wss://relay.example/v1/ws", boards),
            ),
        )
        store.apply(
            DiskOp.PutCatalog(
                CatalogDocument(
                    catalogVersion = 1,
                    migrationState = MigrationState.COMMITTED,
                    order = sessions.map { it.sessionId },
                    sessions = sessions,
                    activeSessionId = sessions.first().sessionId,
                    migrationCredentialId = null,
                ),
            ),
        )
        val relay = HoldingRelay()
        val model = BoardViewModel(store, relay, DoneNotifier(mock(Context::class.java)), englishUi = false)
        model.openAddBoard()
        model.updateDisplayName("Home Mac")
        model.updateHttpBase("https://relay.example")
        model.updatePairCode("pc_" + "a".repeat(43))
        model.pair()
        assertTrue(relay.started.isCompleted)
        assertTrue(model.state.value.busy)
        assertEquals(Screen.AddBoard, model.state.value.screen)
        return Harness(model, store, plain, relay)
    }

    private fun board(id: String, name: String, boardId: String) = PhoneSession(id, "c1", boardId, name, 1)

    private class Harness(
        val model: BoardViewModel,
        val store: SessionStore,
        val plain: MemoryPrefs,
        val relay: HoldingRelay,
    ) {
        fun releaseSuccess() {
            relay.release(
                HttpResult(
                    200,
                    """{"deviceId":"dev_new","deviceToken":"dt_newtoken","role":"phone","boardIds":["board-new"],"expiresAt":80}""",
                ),
            )
        }

        fun persistedOrder(): List<String> = decodeCatalog(plain.getString("catalog", null)!!)!!.order
    }
}

private class HoldingRelay : RelayApi {
    val started = CompletableDeferred<Unit>()
    private val pending = CompletableDeferred<HttpResult>()

    override suspend fun request(method: String, url: String, body: String?): HttpResult {
        if (!started.isCompleted) started.complete(Unit)
        return pending.await()
    }

    fun release(result: HttpResult) {
        pending.complete(result)
    }

    override fun openSocket(credentialId: String, url: String, listener: SocketListener) = Unit
    override fun send(credentialId: String, text: String): Boolean = true
    override fun closeSocket(credentialId: String) = Unit
    override fun closeAll() = Unit
}

private class MemoryPrefs : SharedPreferences {
    private val values = HashMap<String, Any?>()

    override fun getAll(): MutableMap<String, *> = HashMap(values)
    override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
    override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
    override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    override fun contains(key: String): Boolean = key in values
    override fun edit(): SharedPreferences.Editor = Editor()
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit

    private inner class Editor : SharedPreferences.Editor {
        private val puts = HashMap<String, Any?>()
        private val removals = HashSet<String>()
        private var clearAll = false

        override fun putString(key: String, value: String?): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
        override fun putInt(key: String, value: Int): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putLong(key: String, value: Long): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putFloat(key: String, value: Float): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun remove(key: String): SharedPreferences.Editor {
            removals.add(key)
            return this
        }

        override fun clear(): SharedPreferences.Editor {
            clearAll = true
            return this
        }

        override fun commit(): Boolean {
            apply()
            return true
        }

        override fun apply() {
            if (clearAll) values.clear()
            removals.forEach { values.remove(it) }
            puts.forEach { (key, value) ->
                if (value == null) values.remove(key) else values[key] = value
            }
        }
    }
}
