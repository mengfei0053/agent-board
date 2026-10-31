package tech.mengfei.agentboard

import tech.mengfei.agentboard.protocol.BoardInfo
import tech.mengfei.agentboard.protocol.LogLine
import tech.mengfei.agentboard.protocol.RelayTask
import tech.mengfei.agentboard.protocol.ThinWorkspace

sealed interface Screen {
    data object Pair : Screen
    data object Boards : Screen
    data object Settings : Screen
    data object Tasks : Screen
    data object Detail : Screen
    data object Create : Screen
}

data class UiState(
    val screen: Screen = Screen.Pair,
    val httpBase: String = "",
    val wsUrl: String = "",
    val deviceName: String = "Android phone",
    val pairCode: String = "",
    val paired: Boolean = false,
    val secureStore: Boolean = false,
    val connection: String = "offline",
    val boards: List<BoardInfo> = emptyList(),
    val tasks: List<RelayTask> = emptyList(),
    val logs: List<LogLine> = emptyList(),
    val selectedBoardId: String? = null,
    val selectedTaskId: String? = null,
    val needsResync: Boolean = false,
    val banner: String? = null,
    val commandNote: String? = null,
    val formError: String? = null,
    val busy: Boolean = false,
    val draftTitle: String = "",
    val draftPrompt: String = "",
    val draftAgent: String = "pi",
    val draftCwd: String = "",
    val draftUseGitWorktree: Boolean = false,
    val worktreeEnabled: Boolean = false,
    val workspaces: List<ThinWorkspace> = emptyList(),
    val canPop: Boolean = false,
)
