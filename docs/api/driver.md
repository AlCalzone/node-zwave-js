# Driver

The driver is the core of this library. It controls the serial interface, handles transmission and receipt of messages and manages the network cache. Any action you want to perform on the Z-Wave network must go through a driver instance or its associated nodes.

## Constructor

```ts
new (port: string, options?: ZWaveOptions) => Driver
```

The first constructor argument is the address of the serial port. On Windows, this is similar to `"COM3"`. On Linux this has the form `/dev/ttyAMA0` (or similar).
For more control, the constructor accepts an optional options object as the second argument. See [`ZWaveOptions`](#ZWaveOptions) for a detailed desription.

## Driver methods

### `start`

```ts
async start(): Promise<void>
```

This starts the driver and opens the underlying serial port and performs an interview of the controller and all nodes.

The following table gives you an overview of what happens during the startup process. Note that the promise resolves before the interview process is completed:

| Step | What happens behind the scenes                                          | Library response                                        |
| :--: | ----------------------------------------------------------------------- | ------------------------------------------------------- |
|  1   | Serial port is opened                                                   | `start()` Promise resolves                              |
|  2   | Controller interview is performed                                       | `"driver ready"` event is emitted                       |
|  3   | Every node is interviewed in the background (This may take a long time) | `"interview completed"` event is emitted for every node |
|  4   | -                                                                       | `"interview completed"` event is emitted for the driver |

### `getSupportedCCVersionForNode`

```ts
getSupportedCCVersionForNode(nodeId: number, cc: CommandClasses): number
```

Nodes in a Z-Wave network are very likely support different versions of a Command Class (CC) and frequently support older versions than the driver software.  
This method helps determine which version of a CC can be used to control a node. It takes two arguments:

-   `nodeId: number` - The ID that identifies a node in the network
-   `cc: CommandClasses` - The command class whose version should be retrieved

This method

-   returns `0` if the node does not support the given CC
-   also returns `0` if the node interview was not completed yet
-   otherwise returns the version the node claims to support

**Note:** This only provides reliable information **after** the node interview was completed.

### `getSafeCCVersionForNode`

```ts
getSafeCCVersionForNode(nodeId: number, cc: CommandClasses): number
```

Since it might be necessary to control a node **before** its supported CC versions are known, this method helps determine which CC version to use. It takes the same arguments as `getSupportedCCVersionForNode`, but behaves differently. It

-   returns `1` if the node claims not to support the CC or no information is known
-   **throws (!)** if the requested CC is not implemented in this library
-   returns the version the node claims to support otherwise

### `hardReset`

```ts
async hardReset(): Promise<void>
```

Performs a hard reset on the controller. **WARNING:** This wipes out all configuration!

The returned Promise resolves when the hard reset has been performed. It does **not** wait for completion of the initialization process which is started afterwards.

### `destroy`

```ts
async destroy(): Promise<void>
```

This shuts down the driver, closes the serial port and saves the network information to the local cache.

**Note:** Make sure to call this before your application is closed.

### `sendMessage`

```ts
sendMessage<TResponse?>(msg: Message, options?: SendMessageOptions): Promise<TResponse>
```

This method sends a message to the Z-Wave controller. It takes two arguments:

-   `message` - An instance of the message class that should be sent
-   `options` _(optional)_ - Additional options to influence the behavior of the method. See [`SendMessageOptions`](#SendMessageOptions) for a detailed description.

If it is known in advance which type the response will have, you can optionally pass the desired return type.

The behavior of this method strongly depends on the message that should be sent:

-   If the sent message expects a response (this is defined in each message class), the method will wait until that response has been received. In this case, the returned Promise will resolve to that response.
-   If no response is expected, the Promise will resolve after the transmission has been acknowledged by the controller (or the node in case of a `SendDataRequest`).
-   When the message can't be transmitted because the node is asleep, the Promise will only resolve after the node wakes up again and receives the message. Depending on the configuration, this may take a very long time.
-   When the message can't be transmitted due to a timeout, the method will throw.

### `sendCommand`

```ts
async sendCommand<TResponse?>(command: CommandClass, options?: SendMessageOptions): Promise<TResponse | undefined>
```

This method sends a command to a Z-Wave node. It takes two arguments:

-   `command` - An instance of the command class that should be sent
-   `options` _(optional)_ - Additional options to influence the behavior of the method. See [`SendMessageOptions`](#SendMessageOptions) for a detailed description.

If it is known in advance which type the response will have, you can optionally pass the desired return type.

Internally, it wraps the command in a `SendDataRequest` and calls `sendMessage` with it. Anything that applies to `sendMethod` is therefore true for `sendCommand`.

### `saveNetworkToCache`

```ts
async saveNetworkToCache(): Promise<void>
```

This method saves the current state of the Z-Wave network to a cache file. This allows the driver to remember information about the network without having to rely on a time-consuming interview process the next time it is started.  
It is internally used during the interview and by the `destroy` method, so you shouldn't have to call it yourself.

Calls to the method are debounced. This means that the cache file is not guaranteed to be written immediately. However it is guaranteed that the data is persisted soon after the call.

### `restoreNetworkFromCache`

```ts
async restoreNetworkFromCache(): Promise<void>
```

This method restores the network information a previously saved cache file if one exists. Like `saveNetworkToCache` you shouldn't have to use it yourself.

## Driver properties

### `cacheDir`

```ts
readonly cacheDir: string
```

This property returns absolute path of the directory where information about the Z-Wave network is cached.

### `controller`

```ts
readonly controller: ZWaveController
```

Once the `"driver ready"` event was emitted, this property provides access to the controller instance, which contains information about the controller and a list of all nodes.  
**Note:** Don't use it before the driver is ready!

## Driver events

The `Driver` class inherits from the Node.js [EventEmitter](https://nodejs.org/api/events.html#events_class_eventemitter) and thus also supports its methods like `on`, `removeListener`, etc. The following events are implemented:

| Event               | Description                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"error"`           | Is emitted when the underlying serial port emits an error or invalid data is received. You **must** add a listener for this event, otherwise unhandled `"error"` events will crash your application! |
| `"driver ready"`    | Is emitted after the controller interview is completed but before the node interview is started.                                                                                                     |
| `"all nodes ready"` | Is emitted when all nodes are safe to be used (i.e. the `"ready"` event has been emitted for all nodes).                                                                                             |

## Interfaces

### `FileSystem`

```ts
interface FileSystem {
	ensureDir(path: string): Promise<void>;
	writeFile(
		file: string,
		data: string | Buffer,
		options?:
			| {
					encoding: string;
			  }
			| string,
	): Promise<void>;
	readFile(file: string, encoding: string): Promise<string>;
	pathExists(path: string): Promise<boolean>;
}
```

### `SendMessageOptions`

Influences the behavior of `driver.sendMessage`.

```ts
interface SendMessageOptions {
	/** The priority of the message to send. If none is given, the defined default priority of the message class will be used. */
	priority?: MessagePriority;
	/** If an exception should be thrown when the message to send is not supported. Setting this to false is is useful if the capabilities haven't been determined yet. Default: true */
	supportCheck?: boolean;
}
```

The message priority must one of the following enum values. Consuming applications typically don't need to overwrite this.

```ts
/** The priority of messages, sorted from high (0) to low (>0) */
enum MessagePriority {
	// Controller commands are not to be interrupted and usually finish quickly
	Controller = 0,
	// The security queue is the highest actual priority because secured messages
	// require an encryption handshake before sending new messages
	Security = 1,
	// Pings (NoOP) are used for device probing at startup and for network diagnostics
	Ping = 2,
	// Multistep controller commands typically require user interaction but still
	// should happen at a higher priority than any node data exchange
	MultistepController = 3,
	// Whenever sleeping devices wake up, their queued messages must be handled quickly
	// because they want to go to sleep soon. So prioritize them over non-sleeping devices
	WakeUp = 4,
	// Normal operation and node data exchange
	Normal = 5,
	// Node querying is expensive and happens whenever a new node is discovered.
	// In order to keep the system responsive, give them a lower priority
	NodeQuery = 6,
	// Some devices need their state to be polled at regular intervals. Only do that when
	// nothing else needs to be done
	Poll = 7,
}
```

### `ZWaveOptions`

This interface specifies the optional options object that is passed to the `Driver` constructor. All properties are optional and are internally filled with default values.

```ts
interface ZWaveOptions {
	/** Specify timeouts in milliseconds */
	timeouts: {
		/** how long to wait for an ACK */
		ack: number; // default: 1000 ms
		/** not sure */
		byte: number; // default: 150 ms
		/** How much time a node gets to process a request */
		report: number; // default: 1000 ms
	};
	/**
	 * How many attempts should be made for each node interview before giving up
	 */
	nodeInterviewAttempts: number; // default: 5
	/**
	 * Allows you to replace the default file system driver used to store and read the cache
	 */
	fs: FileSystem;
	/** Allows you to specify a different cache directory */
	cacheDir: string;
}
```

The timeout values `ack` and `byte` are sent to the Z-Wave stick using the `SetSerialApiTimeouts` command. Change them only if you know what you're doing.

The `report` timeout is used by this library to determine how long to wait for a node's response.

If your network has connectivity issues, you can increase the number of interview attempts the driver makes before giving up. The default is 5.

For more control over writing the cache file, you can use the `fs` and `cacheDir` options. By default, the cache is located inside `node_modules/zwave-js/cache` and written using Node.js built-in `fs` methods (promisified using `fs-extra`). The replacement file system must adhere to the [`FileSystem`](#FileSystem) interface.
