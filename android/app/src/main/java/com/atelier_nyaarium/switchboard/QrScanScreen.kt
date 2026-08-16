package com.atelier_nyaarium.switchboard

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
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
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Full-screen QR scanner: CameraX preview feeding ML Kit barcode decode. Two things make a
 * DENSE v40 enrollment QR (177 modules, ~2.7 KB) decode reliably:
 *  1. RESOLUTION. A hand-rolled analyzer runs at CameraX's 640x480 default, which gives
 *     under ML Kit's >=2 px/module floor for 177 modules, so it never decodes. We request
 *     the highest analysis resolution (capped ~1080p) via a ResolutionSelector BEFORE bind.
 *  2. FOCUS. A QR on a glossy screen at close range can sit in the macro dead-zone, so we
 *     kick a center focus-metering action once the preview lays out.
 * Frame is fed WITH `rotationDegrees` so orientation is correct. `onResult` fires once.
 * DebugLog traces (debug build flushes them to the Router) confirm the analysis size + decode.
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
			Button(onClick = hapticClick { permLauncher.launch(Manifest.permission.CAMERA) }) { Text("Grant camera access") }
			OutlinedButton(onClick = hapticClick(onCancel)) { Text("Cancel") }
		}
		return
	}

	// getClient can throw if the bundled ML Kit model fails to load; keep it nullable so a failure
	// degrades to the paste fallback instead of crashing during composition.
	val scanner = remember {
		runCatching {
			BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
		}.onFailure { DebugLog.log("QrScan", "getClient failed: ${it.javaClass.simpleName}: ${it.message}") }.getOrNull()
	}
	val controller = remember { LifecycleCameraController(context) }
	val analysisExec = remember { Executors.newSingleThreadExecutor() }
	val handled = remember { AtomicBoolean(false) }
	val frames = remember { AtomicLong(0L) }
	// A camera/scanner init failure (a device CameraX quirk, an R8-shaken member, a missing model)
	// is captured here and rendered on-screen rather than crashing the app. On-screen so it is
	// diagnosable even mid-enrollment, when DebugLog has no creds to flush to the Router.
	var camError by remember { mutableStateOf<String?>(null) }

	DisposableEffect(Unit) {
		onDispose {
			runCatching { controller.unbind() }
			runCatching { scanner?.close() }
			runCatching { analysisExec.shutdown() }
		}
	}

	// Explicit null-check (not folded into a combined string) so the compiler smart-casts `scanner`
	// to non-null for the analyzer below; the immutable val carries the cast into the factory lambda.
	if (scanner == null || camError != null) {
		Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
			Text(
				"Camera couldn't start: ${camError ?: "barcode scanner unavailable"}\n\nGo back and use Paste or Open file instead.",
				color = MaterialTheme.colorScheme.error,
			)
			OutlinedButton(onClick = hapticClick(onCancel)) { Text("Back") }
		}
		return
	}

	Box(Modifier.fillMaxSize()) {
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			factory = { ctx ->
				val view = PreviewView(ctx)

				// All camera init is guarded: a failure here must show the on-screen error (above) and
				// the paste fallback, never crash. This is the real fix for the scan-screen crash; the
				// exact cause rides ${e} so a tester can read or relay it.
				try {
					// THE fix: lift analysis off the 640x480 default so a 177-module QR resolves.
					controller.setImageAnalysisResolutionSelector(
						ResolutionSelector.Builder()
							.setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY)
							.setAllowedResolutionMode(ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE)
							.build(),
					)
					controller.setImageAnalysisAnalyzer(analysisExec) { proxy ->
						val media = proxy.image
						if (media == null || handled.get()) {
							proxy.close()
							return@setImageAnalysisAnalyzer
						}
						val n = frames.incrementAndGet()
						if (n == 1L) DebugLog.log("QrScan", "analysis ${proxy.width}x${proxy.height} rot=${proxy.imageInfo.rotationDegrees}")
						val started = runCatching {
							scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
								.addOnSuccessListener { codes ->
									if (codes.isNotEmpty() || n % 60L == 0L) DebugLog.log("QrScan", "frame $n: ${codes.size} code(s)")
									val raw = codes.firstOrNull()?.rawValue
									if (raw != null && handled.compareAndSet(false, true)) {
										DebugLog.log("QrScan", "decoded ${raw.length} chars")
										runCatching { controller.unbind() }
										onResult(raw)
									}
								}
								.addOnFailureListener { e -> DebugLog.log("QrScan", "process failed: ${e.message}") }
								.addOnCompleteListener { proxy.close() }
						}
						if (started.isFailure) {
							DebugLog.log("QrScan", "analyze threw: ${started.exceptionOrNull()?.message}")
							proxy.close()
						}
					}

					controller.bindToLifecycle(lifecycleOwner)
					view.controller = controller

					// Screen QRs at close range can park AF at infinity; nudge focus to center.
					view.post {
						runCatching {
							val point = view.meteringPointFactory.createPoint(view.width / 2f, view.height / 2f)
							controller.cameraControl?.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
						}
					}
				} catch (e: Throwable) {
					DebugLog.log("QrScan", "camera init failed: ${e.javaClass.simpleName}: ${e.message}")
					camError = "${e.javaClass.simpleName}: ${e.message}"
				}
				view
			},
		)
		OutlinedButton(
			onClick = hapticClick(onCancel),
			modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(24.dp),
		) {
			Text("Cancel")
		}
	}
}
