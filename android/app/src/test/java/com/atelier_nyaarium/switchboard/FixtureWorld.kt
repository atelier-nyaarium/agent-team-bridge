package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.AdmissionCrypto
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.Provisioning
import com.atelier_nyaarium.switchboard.proto.SignedAdmission
import java.util.Base64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

internal class FixtureWorld private constructor(
	val clock: Long,
	val routerIdentity: Crypto.Identity,
	val ownerIdentity: Crypto.Identity,
	val gatewayIdentity: Crypto.Identity,
	val consoleIdentity: Crypto.Identity,
	val gatewayId: String,
	val domainId: String,
	val domain: DomainSnapshot,
	val consoleToken: String,
	val federationToken: String,
	val hostToken: String,
	val contentKey: ByteArray,
	private val device: String,
	private val conversationId: String,
) {
	fun bootstrap(store: AppStateStore = testStore()): PhoneBootstrap {
		store.save(
			wireJson.encodeToString(
				Provisioning.serializer(),
				Provisioning(
					routerUrl = "https://router.test",
					appToken = consoleToken,
					device = device,
					conversationId = conversationId,
				),
			),
		)
		store.saveIdentity(consoleIdentity)
		store.saveOwnerIdentity(ownerIdentity)
		store.saveDomainId(domainId)
		store.saveDomain(wireJson.encodeToString(DomainSnapshot.serializer(), domain), "1")
		check(store.saveContentKeys(mapOf(1 to contentKey)))
		return (PhoneBootstrap.assemble(store, FederationManager(store)) as BootState.Ready).boot
	}

	fun ambient(draws: FixtureDraws): PhoneAmbient = PhoneAmbient(
		now = { clock },
		newNonce = { draws.nextB64(18) },
		newNonceBytes = { draws.next(12) },
		newOpId = { "${draws.case}-op" },
		wrapEntropy = draws::next,
		missingTimer = object : MissingEpochTimer {
			override fun schedule(delayMs: Long, task: suspend () -> Unit) {
				if (delayMs == 0L) kotlinx.coroutines.runBlocking { task() }
			}
		},
	)

	fun client(
		draws: FixtureDraws,
		sender: (suspend (com.atelier_nyaarium.switchboard.proto.OwnerOp) -> kotlinx.serialization.json.JsonElement?)? = null,
		onSign: ((com.atelier_nyaarium.switchboard.proto.OwnerOp) -> Unit)? = null,
		coordinator: ConsoleTransportCoordinator? = null,
	): ConsoleClient {
		check(contentKey.contentEquals(Crypto.deriveContentKey(ownerIdentity.sign.priv, domainId, 1)))
		val store = testStore().also { it.saveGatewayId(gatewayId) }
		val boot = bootstrap(store)
		val ambient = ambient(draws)
		val signer = OwnerOps(boot, ambient)
		return ConsoleClient(
			boot,
			ambient,
			store,
			coordinator = coordinator,
			collaborators = ConsoleClientCollaborators(
				signOwnerOp = { op, opId -> signer.sign(op, opId).also { onSign?.invoke(it) } },
				homeGatewayId = { gatewayId },
				saveProvisioning = store::save,
				postOwnerOpSender = sender,
			),
		)
	}

	companion object {
		fun fromResources(): FixtureWorld {
			val text = FixtureWorld::class.java.classLoader?.getResourceAsStream("identity/set.json")?.bufferedReader()?.use { it.readText() }
				?: error("missing fixture: identity/set.json")
			return from(wireJson.parseToJsonElement(text).jsonObject)
		}

		fun from(root: JsonObject): FixtureWorld {
			val domainRoot = root.getValue("domain").jsonObject
			val gatewayRoot = root.getValue("gateway").jsonObject
			val consoleRoot = root.getValue("console").jsonObject
			val owner = wireJson.decodeFromJsonElement<Crypto.Identity>(domainRoot.getValue("owner"))
			val gateway = wireJson.decodeFromJsonElement<Crypto.Identity>(gatewayRoot.getValue("identity"))
			val console = wireJson.decodeFromJsonElement<Crypto.Identity>(consoleRoot.getValue("identity"))
			val admissions = listOf(
				wireJson.decodeFromJsonElement<SignedAdmission>(gatewayRoot.getValue("admission")),
				wireJson.decodeFromJsonElement<SignedAdmission>(consoleRoot.getValue("admission")),
			)
			check(admissions.all { AdmissionCrypto.verifyAdmission(it, owner.sign.pub) }) { "fixture admission is invalid" }
			val domain = DomainSnapshot(owner.sign.pub, admissions, emptyList())
			val id = domainRoot.getValue("id").jsonPrimitive.content
			val key = Base64.getDecoder().decode(root.getValue("content").jsonObject.getValue("key").jsonPrimitive.content)
			check(key.contentEquals(Crypto.deriveContentKey(owner.sign.priv, id, 1)))
			val tokens = root.getValue("tokens").jsonObject
			return FixtureWorld(
				root.getValue("issuedAt").jsonPrimitive.long,
				wireJson.decodeFromJsonElement(root.getValue("router").jsonObject.getValue("identity")),
				owner,
				gateway,
				console,
				gatewayRoot.getValue("id").jsonPrimitive.content,
				id,
				domain,
				tokens.getValue("console").jsonPrimitive.content,
				tokens.getValue("federation").jsonPrimitive.content,
				tokens.getValue("host").jsonPrimitive.content,
				key,
				consoleRoot.getValue("device").jsonPrimitive.content,
				consoleRoot.getValue("conversationId").jsonPrimitive.content,
			)
		}
	}
}
