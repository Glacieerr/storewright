classdef StoreXTwinClient < handle
    %STOREXTWINCLIENT 孪生服务（server/twinServer.ts）的 REST 客户端，接口见 server/protocol.md。
    %
    %   c = StoreXTwinClient("http://127.0.0.1:8787");
    %   s = c.state();                      % 此刻：时间、指标、每辆车的位置和延误、门店库存
    %   [msgs, next] = c.messages(0, 500);  % 现场发出的感知数据
    %   cards = c.recommendations();        % 孪生的建议卡
    %   c.approve(cards{1}.key);            % 批准推荐的做法（或 c.approve(key, "rescue")）
    %   c.command(struct('kind', 'restock', 'fam', 'DAIRY', 'units', 2000));
    %   c.control('speed', 60);

    properties
        BaseUrl (1, 1) string = "http://127.0.0.1:8787"
        Options
    end

    methods
        function obj = StoreXTwinClient(baseUrl)
            if nargin > 0
                obj.BaseUrl = string(baseUrl);
            end
            obj.Options = weboptions('MediaType', 'application/json', 'ContentType', 'json', 'Timeout', 15);
        end

        function m = model(obj)
            m = webread(obj.BaseUrl + "/api/model", obj.Options);
        end

        function s = state(obj)
            s = webread(obj.BaseUrl + "/api/state", obj.Options);
        end

        function [msgs, next] = messages(obj, since, limit)
            if nargin < 2, since = 0; end
            if nargin < 3, limit = 1000; end
            r = webread(obj.BaseUrl + "/api/messages", 'since', since, 'limit', limit, obj.Options);
            msgs = r.msgs;
            if ~iscell(msgs)
                msgs = num2cell(msgs);
            end
            next = r.next;
        end

        function cards = recommendations(obj)
            cards = webread(obj.BaseUrl + "/api/recommendations", obj.Options);
            if ~iscell(cards)
                cards = num2cell(cards);
            end
        end

        function r = approve(obj, key, option)
            body = struct('key', key);
            if nargin > 2
                body.option = option;
            end
            r = webwrite(obj.BaseUrl + "/api/approve", body, obj.Options);
        end

        function r = reject(obj, key)
            r = webwrite(obj.BaseUrl + "/api/reject", struct('key', key), obj.Options);
        end

        function r = command(obj, cmd)
            r = webwrite(obj.BaseUrl + "/api/command", cmd, obj.Options);
        end

        function r = control(obj, varargin)
            body = struct(varargin{:});
            r = webwrite(obj.BaseUrl + "/api/control", body, obj.Options);
        end
    end
end
