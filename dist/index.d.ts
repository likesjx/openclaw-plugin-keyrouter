type OpenClawPluginCommandDefinition = {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: {
        args?: string;
    }) => Promise<{
        text: string;
        isError?: boolean;
    }>;
};
type OpenClawPluginApi = {
    logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    registerCommand: (cmd: OpenClawPluginCommandDefinition) => void;
    pluginConfig?: unknown;
    registerCli: (registrar: (ctx: {
        program: {
            command: (name: string) => {
                description: (text: string) => unknown;
                command: (name: string) => {
                    description: (text: string) => unknown;
                    argument: (spec: string, description?: string) => unknown;
                    action: (...args: unknown[]) => unknown;
                };
                action: (...args: unknown[]) => unknown;
            };
        };
        logger: {
            info: (msg: string) => void;
            warn: (msg: string) => void;
            error: (msg: string) => void;
        };
    }) => void | Promise<void>, opts?: {
        commands?: string[];
    }) => void;
    registerHook?: (events: string | string[], handler: (...args: unknown[]) => unknown) => void;
    on: (hookName: string, handler: (...args: unknown[]) => unknown) => void;
};
type OpenClawPluginDefinition = {
    id: string;
    name: string;
    description: string;
    version: string;
    register: (api: OpenClawPluginApi) => void;
};

declare const plugin: OpenClawPluginDefinition;

export { plugin as default };
