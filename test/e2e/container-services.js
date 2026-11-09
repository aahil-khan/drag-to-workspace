// Stands in for logind and localed inside test containers, which GNOME Shell won't start
// without. They only have to exist on the system bus: the tests use neither for real.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MANAGER = `<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="Inhibit">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="h" direction="out"/>
    </method>
    <method name="GetSession">
      <arg type="s" direction="in"/>
      <arg type="o" direction="out"/>
    </method>
    <method name="GetSessionByPID">
      <arg type="u" direction="in"/>
      <arg type="o" direction="out"/>
    </method>
    <method name="ListSessions">
      <arg type="a(susso)" direction="out"/>
    </method>
    <method name="CanSuspend">
      <arg type="s" direction="out"/>
    </method>
    <method name="CanRebootToBootLoaderMenu">
      <arg type="s" direction="out"/>
    </method>
    <signal name="PrepareForSleep">
      <arg type="b"/>
    </signal>
    <signal name="PrepareForShutdown">
      <arg type="b"/>
    </signal>
  </interface>
</node>`;

const LOCALE = `<node>
  <interface name="org.freedesktop.locale1">
    <property name="Locale" type="as" access="read"/>
    <property name="X11Layout" type="s" access="read"/>
    <property name="X11Model" type="s" access="read"/>
    <property name="X11Variant" type="s" access="read"/>
    <property name="X11Options" type="s" access="read"/>
    <property name="VConsoleKeymap" type="s" access="read"/>
    <property name="VConsoleKeymapToggle" type="s" access="read"/>
  </interface>
</node>`;

const loop = new GLib.MainLoop(null, false);
const unsupported = invocation => invocation.return_dbus_error(
    'org.freedesktop.DBus.Error.NotSupported', 'test stand-in');

Gio.bus_own_name(Gio.BusType.SYSTEM, 'org.freedesktop.login1', Gio.BusNameOwnerFlags.NONE,
    connection => {
        const info = Gio.DBusNodeInfo.new_for_xml(MANAGER).interfaces[0];
        connection.register_object('/org/freedesktop/login1', info,
            (_conn, _sender, _path, _iface, method, _params, invocation) => {
                if (method === 'CanSuspend' || method === 'CanRebootToBootLoaderMenu')
                    invocation.return_value(new GLib.Variant('(s)', ['no']));
                else if (method === 'ListSessions')
                    invocation.return_value(new GLib.Variant('(a(susso))', [[]]));
                else
                    unsupported(invocation);
            }, null, null);
    }, null, () => loop.quit());

Gio.bus_own_name(Gio.BusType.SYSTEM, 'org.freedesktop.locale1', Gio.BusNameOwnerFlags.NONE,
    connection => {
        const info = Gio.DBusNodeInfo.new_for_xml(LOCALE).interfaces[0];
        connection.register_object('/org/freedesktop/locale1', info,
            (_conn, _sender, _path, _iface, _method, _params, invocation) => unsupported(invocation),
            (_conn, _sender, _path, _iface, property) => {
                if (property === 'Locale')
                    return new GLib.Variant('as', ['LANG=C.UTF-8']);
                return new GLib.Variant('s', property === 'X11Layout' ? 'us' : '');
            }, null);
    }, null, () => loop.quit());

loop.run();
