package tech.mengfei.agentboard.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import tech.mengfei.agentboard.R

@Composable
internal fun DetailPromptField(
    value: String,
    onChange: (String) -> Unit,
    onQueue: (() -> Unit)? = null,
) {
    val label = stringResource(if (onQueue == null) R.string.continue_prompt_label else R.string.detail_queue_prompt)
    OutlinedTextField(
        value,
        onChange,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
        placeholder = { Text(label, maxLines = 1) },
        singleLine = onQueue != null,
        maxLines = if (onQueue == null) 2 else 1,
        keyboardOptions = KeyboardOptions(imeAction = if (onQueue == null) ImeAction.Default else ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = onQueue?.let { queue -> { queue() } }),
        textStyle = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
internal fun FollowupRow(
    prompt: String,
    canSend: Boolean,
    canRemove: Boolean,
    needsLookup: Boolean,
    onSend: () -> Unit,
    onRemove: () -> Unit,
) {
    HorizontalDivider()
    SelectionContainer { Text(prompt, style = MaterialTheme.typography.bodyMedium) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onSend, Modifier.weight(1f), enabled = canSend) {
            Text(stringResource(if (needsLookup) R.string.check_stored else R.string.detail_queue_send))
        }
        TextButton(onRemove, enabled = canRemove) { Text(stringResource(R.string.delete)) }
    }
}

@Composable
internal fun DetailActionDialog(
    title: String,
    onClose: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(title) },
        text = {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                content = content,
            )
        },
        confirmButton = { TextButton(onClose) { Text(stringResource(R.string.log_close)) } },
    )
}
