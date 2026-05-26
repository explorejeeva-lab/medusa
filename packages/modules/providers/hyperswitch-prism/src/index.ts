import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import HyperswitchPrismBase from "./core/hyperswitch-prism-base"

const services = [HyperswitchPrismBase]

export default ModuleProvider(Modules.PAYMENT, { services })
