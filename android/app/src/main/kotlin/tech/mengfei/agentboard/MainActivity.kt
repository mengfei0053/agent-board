package tech.mengfei.agentboard

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import tech.mengfei.agentboard.ui.AgentBoardTheme
import tech.mengfei.agentboard.ui.RootScreen

class MainActivity : ComponentActivity() {
    private val model: BoardViewModel by viewModels {
        val application = application
        check(application is AgentBoardApp)
        BoardViewModelFactory(application)
    }

    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            val state by model.state.collectAsState()
            AgentBoardTheme {
                RootScreen(state, model)
            }
        }
    }
}
