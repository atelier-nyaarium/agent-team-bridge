package com.atelier_nyaarium.switchboard

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/**
 * Full-screen QR scanner: a CameraX preview feeding ML Kit barcode decode. ML Kit (the
 * engine most dedicated scanner apps use) reads dense v40 QRs reliably, and feeding each
 * frame WITH `imageProxy.imageInfo.rotationDegrees` fixes the sideways/distorted preview
 * that broke the old zxing capture Activity. `onResult` fires exactly once with the
 * decoded text; `onCancel` backs out. Camera permission is requested on entry.
 */
@OptIn(ExperimentalGetImage::class)
@Composable
fun QrScanScreen(onResult: (String) -> Unit, onCancel: () -> Unit) {
	val context = LocalContext.current
	val lifecycleOwner = LocalLifecycleOwner.current

	var granted by remember {
		mutableStateOf(
			ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
		)
	}
	val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
	LaunchedEffect(Unit) { if (!granted) permLauncher.launch(Manifest.permission.CAMERA) }

	if (!granted) {
		Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
			Text("Camera permission is needed to scan the enrollment QR.", color = MaterialTheme.colorScheme.error)
			Button(onClick = { permLauncher.launch(Manifest.permission.CAMERA) }) { Text("Grant camera access") }
			OutlinedButton(onClick = onCancel) { Text("Cancel") }
		}
		return
	}

	val scanner = remember {
		BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
	}
	val controller = remember { LifecycleCameraController(context) }
	var handled by remember { mutableStateOf(false) }

	DisposableEffect(Unit) {
		onDispose {
			runCatching { controller.unbind() }
			runCatching { scanner.close() }
		}
	}

	Box(Modifier.fillMaxSize()) {
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			factory = { ctx ->
				val view = PreviewView(ctx)
				val exec = ContextCompat.getMainExecutor(ctx)
				controller.setImageAnalysisAnalyzer(exec) { proxy ->
					val media = proxy.image
					if (media == null || handled) {
						proxy.close()
						return@setImageAnalysisAnalyzer
					}
					val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
					scanner.process(input)
						.addOnSuccessListener { codes ->
							val raw = codes.firstOrNull()?.rawValue
							if (!handled && raw != null) {
								handled = true
								runCatching { controller.unbind() }
								onResult(raw)
							}
						}
						.addOnCompleteListener { proxy.close() }
				}
				controller.bindToLifecycle(lifecycleOwner)
				view.controller = controller
				view
			},
		)
		OutlinedButton(onClick = onCancel, modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp)) {
			Text("Cancel")
		}
	}
}
