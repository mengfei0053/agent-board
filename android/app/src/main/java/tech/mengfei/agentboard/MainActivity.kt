package tech.mengfei.agentboard

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import tech.mengfei.agentboard.Screen
import tech.mengfei.agentboard.ui.AgentBoardTheme
import tech.mengfei.agentboard.ui.RootScreen

class MainActivity : ComponentActivity() {
    private val model: BoardViewModel by viewModels { BoardViewModelFactory(application as AgentBoardApp) }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val state by model.state.collectAsState()
            LaunchedEffect(state.paired) {
                if (state.paired && Build.VERSION.SDK_INT >= 33) {
                    notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
            LaunchedEffect(state.screen) {
                if (state.screen == Screen.Pair) {
                    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
            }
            BackHandler(enabled = state.canPop) { model.pop() }
            AgentBoardTheme {
                RootScreen(state, model)
            }
        }
    }
}
